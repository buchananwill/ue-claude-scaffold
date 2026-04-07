/**
 * Agent Compiler — resolves dynamic agent definitions into standalone agent files.
 *
 * A dynamic agent is a markdown file with YAML frontmatter that includes a `skills`
 * list. The compiler reads each referenced skill, splices its content into the agent's
 * system prompt body, and writes a standard Claude Code agent file (no `skills` field)
 * to the output directory.
 *
 * This is a line-for-line port of scripts/compile-agent.py to TypeScript.
 * The compiled output must be byte-identical for the same inputs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const FRONTMATTER_RE = /^---\s*\n(.*?\n)---\s*\n/s;
const ACCESS_SCOPE_RE = /^\*{3}ACCESS SCOPE:\s*(.+?)\*{3}\s*$/m;

/**
 * Privilege ordering for access scopes. When multiple skills declare scopes,
 * the highest rank wins. Unknown scopes default to rank 1 (write-access).
 */
export const SCOPE_RANK: Record<string, number> = {
  'read-only': 0,
  'write-access': 1,
  'ubt-build-hook-interceptor': 2,
};

/**
 * Split a markdown file into frontmatter dict and body.
 *
 * Uses simple line-based parsing to avoid external YAML dependencies.
 * Handles scalar values, single-line lists (JSON-style), and multi-line lists.
 */
export function parseFrontmatter(text: string): { meta: Record<string, string | string[]>; body: string } {
  const m = FRONTMATTER_RE.exec(text);
  if (!m) {
    return { meta: {}, body: text };
  }

  const raw = m[1];
  const body = text.slice(m[0].length);
  const meta: Record<string, string | string[]> = {};
  let currentKey: string | null = null;

  for (const line of raw.split('\n')) {
    // raw ends with \n, so last element after split is empty string
    const stripped = line.trim();
    if (stripped.startsWith('#') || stripped === '') {
      continue;
    }

    // Continuation of a multi-line list
    if (line.startsWith('  - ') && currentKey !== null) {
      const val = line.trim().replace(/^- /, '').trim();
      const existing = meta[currentKey];
      if (Array.isArray(existing)) {
        existing.push(val);
      }
      continue;
    }

    if (!line.includes(':')) {
      continue;
    }

    const colonIdx = line.indexOf(':');
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    currentKey = key;

    // Inline list: [a, b, c] or ["a", "b", "c"]
    if (val.startsWith('[') && val.endsWith(']')) {
      const items = val.slice(1, -1).split(',');
      meta[key] = items
        .filter(i => i.trim() !== '')
        .map(i => i.trim().replace(/^["']/, '').replace(/["']$/, ''));
    }
    // Quoted string
    else if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      meta[key] = val.slice(1, -1);
    }
    // Empty value — start of a multi-line list
    else if (val === '') {
      meta[key] = [];
    } else {
      meta[key] = val;
    }
  }

  return { meta, body };
}

/**
 * Serialize a metadata dict back to YAML frontmatter.
 */
export function serializeFrontmatter(meta: Record<string, string | string[]>): string {
  const lines: string[] = ['---'];
  for (const [key, val] of Object.entries(meta)) {
    if (Array.isArray(val)) {
      // Inline list format for compactness
      const quoted = val.join(', ');
      lines.push(`${key}: [${quoted}]`);
    } else if (typeof val === 'string' && (val.includes('\n') || val.includes(':') || val.includes('"'))) {
      lines.push(`${key}: "${val}"`);
    } else {
      lines.push(`${key}: ${val}`);
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

/**
 * Load a skill's content (body only, no frontmatter) by name.
 *
 * Returns { body, accessScope } where accessScope is the value from an
 * `***ACCESS SCOPE: {value}***` marker line, or null if absent.
 * The marker line is stripped from the returned body.
 */
export function resolveSkill(name: string, skillsDir: string): { body: string; accessScope: string | null } {
  const skillPath = path.join(skillsDir, name, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    process.stderr.write(`ERROR: Skill '${name}' not found at ${skillPath}\n`);
    process.exit(1);
  }

  const text = fs.readFileSync(skillPath, 'utf-8');
  const { body: rawBody } = parseFrontmatter(text);

  let accessScope: string | null = null;
  let body = rawBody;
  const scopeMatch = ACCESS_SCOPE_RE.exec(body);
  if (scopeMatch) {
    accessScope = scopeMatch[1].trim();
    body = body.slice(0, scopeMatch.index) + body.slice(scopeMatch.index + scopeMatch[0].length);
  }

  return { body: body.trim(), accessScope };
}

/**
 * Compile a dynamic agent definition into a standalone agent file.
 *
 * Returns { outputPath, compiledBody } — the body is needed for recursive
 * sub-agent scanning.
 */
export function compileAgent(
  source: string,
  outputDir: string,
  skillsDir: string,
): { outputPath: string; compiledBody: string } {
  const text = fs.readFileSync(source, 'utf-8');
  const { meta, body } = parseFrontmatter(text);

  const skills = (meta['skills'] as string[] | undefined) ?? [];
  delete meta['skills'];
  if (skills.length === 0) {
    process.stderr.write(`WARNING: ${path.basename(source)} has no skills listed — copying as-is\n`);
  }

  // Build the compiled body: original "why" paragraph + injected skills
  const sections: string[] = [body.trim()];

  let highestScope = 'read-only';
  for (const skillName of skills) {
    const { body: skillContent, accessScope } = resolveSkill(skillName, skillsDir);
    if (accessScope !== null) {
      if ((SCOPE_RANK[accessScope] ?? 1) > (SCOPE_RANK[highestScope] ?? 0)) {
        highestScope = accessScope;
      }
    }
    sections.push(skillContent);
  }

  const compiledBody = sections.join('\n\n').trimEnd() + '\n';
  const compiledFrontmatter = serializeFrontmatter(meta);

  fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, path.basename(source));
  fs.writeFileSync(outPath, compiledFrontmatter + '\n' + compiledBody, 'utf-8');

  // Write sidecar metadata (consumed by container entrypoint, not by Claude Code)
  const stem = path.basename(source, '.md');
  const metaPath = path.join(outputDir, stem + '.meta.json');
  fs.writeFileSync(metaPath, JSON.stringify({ 'access-scope': highestScope }, null, 2) + '\n', 'utf-8');

  return { outputPath: outPath, compiledBody };
}

/**
 * Scan compiled body for references to other dynamic agents.
 *
 * Matches any occurrence of a dynamic agent name (filename sans .md extension)
 * in the compiled text. Returns paths to matched dynamic agent source files,
 * excluding any names in the exclude set (already compiled).
 */
export function findSubAgents(compiledBody: string, dynamicDir: string, exclude: Set<string>): string[] {
  const candidates: Map<string, string> = new Map();
  if (!fs.existsSync(dynamicDir)) {
    return [];
  }
  const entries = fs.readdirSync(dynamicDir).filter(f => f.endsWith('.md')).sort();
  for (const f of entries) {
    const name = f.replace(/\.md$/, '');
    candidates.set(name, path.join(dynamicDir, f));
  }

  const matched: string[] = [];
  // sorted() in Python — candidates are already from sorted entries
  for (const [name, filePath] of candidates) {
    if (exclude.has(name)) {
      continue;
    }
    // Match the agent name as a whole word (not a substring of something else)
    const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
    if (re.test(compiledBody)) {
      matched.push(filePath);
    }
  }

  return matched;
}
