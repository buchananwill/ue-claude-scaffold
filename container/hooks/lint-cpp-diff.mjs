#!/usr/bin/env node
/**
 * PreToolUse lint hook for Edit/Write on C++ files.
 *
 * Checks the new content (from Edit's new_string or Write's content) against
 * mechanical rules that are always wrong in Unreal Engine C++. Returns feedback
 * lines that the agent sees immediately.
 *
 * Input: JSON on stdin with tool_input containing either:
 *   - new_string (Edit tool)
 *   - content (Write tool)
 *   - file_path
 *
 * Exit 0: no issues (tool proceeds)
 * Exit 2 + stdout: issues found (tool is BLOCKED, agent sees feedback and must fix)
 */

import { fileURLToPath } from 'node:url';

/**
 * Check lines of C++ code for lint issues.
 * @param {string[]} lines
 * @param {string} filePath
 * @returns {string[]}
 */
export function checkLines(lines, filePath) {
  const issues = [];

  // Track multiline state for IILE detection
  const fullText = lines.join('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const stripped = line.trim();

    // Skip comments and preprocessor
    if (stripped.startsWith('//') || stripped.startsWith('#') || stripped.startsWith('/*') || stripped.startsWith('*')) {
      continue;
    }

    // Rule 1: East-const violation
    // Match "const Type&" or "const Type*" but not "const_cast" or "constexpr"
    if (/\bconst\s+(?!cast|expr|eval)\w+[\s*&]/.test(line)) {
      const match = line.match(/\bconst\s+(\w+)\s*[&*]/);
      if (match) {
        const typename = match[1];
        if (!['cast', 'expr', 'eval', 'override', 'noexcept'].includes(typename)) {
          issues.push(
            `  LINT [${filePath}:${lineNum}] East-const: ` +
            `'const ${typename}' should be '${typename} const'. ` +
            `Line: ${stripped.slice(0, 80)}`
          );
        }
      }
    }

    // Rule 2: const_cast is banned
    if (line.includes('const_cast')) {
      issues.push(
        `  LINT [${filePath}:${lineNum}] const_cast: ` +
        `const_cast is banned — fix the const-correctness of the API instead. ` +
        `Line: ${stripped.slice(0, 80)}`
      );
    }

    // Rule 3: Anonymous namespaces (break unity builds)
    if (/\bnamespace\s*\{/.test(line)) {
      issues.push(
        `  LINT [${filePath}:${lineNum}] Anonymous namespace: ` +
        `breaks unity builds. Before adding a named namespace like Resort::X::Private, ` +
        `check: (1) does this helper already exist elsewhere in the module? ` +
        `(2) should it be exposed in the header in a proper namespace instead? ` +
        `Line: ${stripped.slice(0, 80)}`
      );
    }

    // Rule 4: Greedy lambda captures [&] or [=]
    // Two branches match Python's structure: one for (params) lambdas, one for {body} no-arg lambdas
    if (/\[&\]\s*\(/.test(line) || /\[=\]\s*\(/.test(line)) {
      issues.push(
        `  LINT [${filePath}:${lineNum}] Greedy capture: ` +
        `use explicit captures instead of [&] or [=]. ` +
        `Line: ${stripped.slice(0, 80)}`
      );
    } else if (/\[&\]\s*\{/.test(line) || /\[=\]\s*\{/.test(line)) {
      issues.push(
        `  LINT [${filePath}:${lineNum}] Greedy capture: ` +
        `use explicit captures instead of [&] or [=]. ` +
        `Line: ${stripped.slice(0, 80)}`
      );
    }

    // Rule 5: Raw new (outside blessed functions)
    // Strip string literals before checking for raw new
    const lineNoStrings = line.replace(/"[^"]*"/g, '').replace(/TEXT\s*\([^)]*\)/g, '');
    const newMatch = lineNoStrings.match(/\bnew\s+([A-Z]\w+)/);
    if (newMatch) {
      const blessed = ['NewObject', 'MakeShared', 'MakeUnique', 'MakeShareable',
        'CreateDefaultSubobject', 'placement', 'operator'];
      if (!blessed.some(b => lineNoStrings.includes(b))) {
        issues.push(
          `  LINT [${filePath}:${lineNum}] Raw new: ` +
          `use NewObject<T>, MakeShared<T>, or MakeUnique<T> instead. ` +
          `Line: ${stripped.slice(0, 80)}`
        );
      }
    }

    // Rule 6: Multiple declarations on one line
    if (/^\s*\w[\w:<>*&\s]+\s+\w+\s*,\s*\w+\s*[;=]/.test(line)) {
      const beforeComma = line.split(',')[0];
      if (!beforeComma.includes('(') && !stripped.startsWith('for') && !stripped.startsWith('template')) {
        issues.push(
          `  LINT [${filePath}:${lineNum}] Multiple declarations: ` +
          `declare one symbol per line. ` +
          `Line: ${stripped.slice(0, 80)}`
        );
      }
    }

    // Rule 7: Uninitialised TSharedRef member field
    if (/\bTSharedRef\s*<[^>]+>\s+\w+\s*;/.test(line)) {
      if (!line.includes('=') && !line.includes('{')) {
        issues.push(
          `  LINT [${filePath}:${lineNum}] Uninitialised TSharedRef: ` +
          `TSharedRef has no null state — initialise with MakeShared<T>() ` +
          `or use TSharedPtr if initialisation is deferred. ` +
          `Line: ${stripped.slice(0, 80)}`
        );
      }
    }
  }

  // Rule 8: IILE detection (multiline — scan full text)
  const iilePattern = /\]\s*\([^)]*\)\s*(?:->[^{]+)?\s*\{[^}]*\}\s*\(\)/gs;
  let iileMatch;
  while ((iileMatch = iilePattern.exec(fullText)) !== null) {
    const lineNum = fullText.slice(0, iileMatch.index).split('\n').length;
    const context = fullText.slice(iileMatch.index, iileMatch.index + iileMatch[0].length).split('\n')[0].trim().slice(0, 80);
    issues.push(
      `  LINT [${filePath}:${lineNum}] IILE: ` +
      `immediately invoked lambda — extract to a named variable or function. ` +
      `Line: ${context}`
    );
  }

  return issues;
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    if (!raw.trim()) {
      process.exit(0);
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      process.exit(0);
    }

    const toolInput = data.tool_input || {};
    const filePath = toolInput.file_path || '';

    // Only lint C++ files
    if (!filePath.endsWith('.h') && !filePath.endsWith('.cpp') && !filePath.endsWith('.inl')) {
      process.exit(0);
    }

    // Get the content being written
    const content = toolInput.new_string || toolInput.content || '';
    if (!content) {
      process.exit(0);
    }

    const lines = content.split('\n');
    const issues = checkLines(lines, filePath);

    if (issues.length > 0) {
      const s = issues.length !== 1 ? 's' : '';
      console.log(`C++ lint (${issues.length} issue${s}):`);
      for (const issue of issues) {
        console.log(issue);
      }
      console.log('');
      console.log('Fix these before proceeding. These patterns are always wrong in this codebase.');
      process.exit(2);
    }

    process.exit(0);
  });
}

// Run main when executed directly (not imported)
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
