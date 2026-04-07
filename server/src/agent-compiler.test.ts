import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  parseFrontmatter,
  serializeFrontmatter,
  resolveSkill,
  compileAgent,
  findSubAgents,
  SCOPE_RANK,
} from './agent-compiler.js';

let tmpDir: string;

function makeDir(...parts: string[]): string {
  const dir = path.join(tmpDir, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(relPath: string, content: string): string {
  const fullPath = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

describe('agent-compiler', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-compiler-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('parseFrontmatter', () => {
    it('parses scalar values', () => {
      const text = '---\nname: test-agent\nmodel: opus\n---\n\nBody text here.\n';
      const { meta, body } = parseFrontmatter(text);
      assert.equal(meta['name'], 'test-agent');
      assert.equal(meta['model'], 'opus');
      assert.equal(body, 'Body text here.\n');
    });

    it('parses inline lists', () => {
      const text = '---\ntools: [Read, Write, Bash]\n---\n\nBody\n';
      const { meta } = parseFrontmatter(text);
      assert.deepEqual(meta['tools'], ['Read', 'Write', 'Bash']);
    });

    it('parses multi-line lists', () => {
      const text = '---\nskills:\n  - alpha\n  - beta\n  - gamma\n---\n\nBody\n';
      const { meta } = parseFrontmatter(text);
      assert.deepEqual(meta['skills'], ['alpha', 'beta', 'gamma']);
    });

    it('parses quoted strings', () => {
      const text = '---\ndescription: "A test: with colons"\n---\n\nBody\n';
      const { meta } = parseFrontmatter(text);
      assert.equal(meta['description'], 'A test: with colons');
    });

    it('returns empty meta and full text when no frontmatter', () => {
      const text = 'No frontmatter here.\n';
      const { meta, body } = parseFrontmatter(text);
      assert.deepEqual(meta, {});
      assert.equal(body, text);
    });

    it('strips all leading dashes and spaces from list items (Python lstrip behavior)', () => {
      const text = '---\nskills:\n  - - dash-prefixed-value\n  - normal\n---\n\nBody\n';
      const { meta } = parseFrontmatter(text);
      assert.deepEqual(meta['skills'], ['dash-prefixed-value', 'normal']);
    });

    it('skips comment and blank lines', () => {
      const text = '---\n# comment\nname: test\n\nmodel: opus\n---\n\nBody\n';
      const { meta } = parseFrontmatter(text);
      assert.equal(meta['name'], 'test');
      assert.equal(meta['model'], 'opus');
      assert.equal(Object.keys(meta).length, 2);
    });
  });

  describe('serializeFrontmatter', () => {
    it('serializes scalars', () => {
      const result = serializeFrontmatter({ name: 'test', model: 'opus' });
      assert.equal(result, '---\nname: test\nmodel: opus\n---\n');
    });

    it('serializes lists as inline format', () => {
      const result = serializeFrontmatter({ tools: ['Read', 'Write', 'Bash'] });
      assert.equal(result, '---\ntools: [Read, Write, Bash]\n---\n');
    });

    it('quotes strings with colons', () => {
      const result = serializeFrontmatter({ desc: 'has: colon' });
      assert.equal(result, '---\ndesc: "has: colon"\n---\n');
    });

    it('quotes strings with double quotes — Python-compatible (no escaping)', () => {
      // Python writes f'{key}: "{val}"' verbatim — interior double quotes are NOT escaped.
      // This is a known Python-compatible limitation producing technically broken YAML.
      const result = serializeFrontmatter({ desc: 'has "quotes"' });
      assert.equal(result, '---\ndesc: "has "quotes""\n---\n');
    });
  });

  describe('frontmatter round-trip', () => {
    it('parse then serialize produces identical output for simple meta', () => {
      const original = '---\nname: test-agent\nmodel: opus\ntools: [Read, Write]\n---\n';
      const { meta } = parseFrontmatter(original + '\nBody\n');
      const serialized = serializeFrontmatter(meta);
      assert.equal(serialized, original);
    });

    it('colon-containing value round-trips correctly', () => {
      const original = '---\ndesc: "value: with colon"\n---\n';
      const { meta } = parseFrontmatter(original + '\nBody\n');
      const serialized = serializeFrontmatter(meta);
      assert.equal(serialized, original);
    });

    it('double-quote value round-trips only by accident (known Python-compatible limitation)', () => {
      // Python's serialize_frontmatter does not escape interior double quotes,
      // producing technically invalid YAML like: desc: "has "quotes""
      // Our parser happens to recover the original value because it only strips
      // the outermost quotes, but a strict YAML parser would reject this.
      const meta = { desc: 'has "quotes"' };
      const serialized = serializeFrontmatter(meta);
      // Serialized form has unescaped interior quotes (broken YAML)
      assert.equal(serialized, '---\ndesc: "has "quotes""\n---\n');
      // Our lenient parser happens to recover the value — but this is fragile
      const { meta: reparsed } = parseFrontmatter(serialized + '\nBody\n');
      assert.equal(reparsed['desc'], 'has "quotes"');
    });
  });

  describe('exact compiled output', () => {
    it('asserts exact full content of compiled output (frontmatter + separator + body)', () => {
      const skillsDir = makeDir('skills');
      const outputDir = path.join(tmpDir, 'output');

      writeFile('skills/only-skill/SKILL.md',
        '---\nname: only-skill\ndescription: The only skill\n---\n\n# Only Skill\n\nSkill body here.\n');

      const source = writeFile('dynamic/exact-agent.md',
        '---\nname: exact-agent\nmodel: opus\nskills:\n  - only-skill\n---\n\nAgent preamble.\n');

      compileAgent(source, outputDir, skillsDir);
      const compiled = fs.readFileSync(path.join(outputDir, 'exact-agent.md'), 'utf-8');

      const expected =
        '---\nname: exact-agent\nmodel: opus\n---\n' +
        '\n' +
        'Agent preamble.\n' +
        '\n' +
        '# Only Skill\n' +
        '\n' +
        'Skill body here.\n';
      assert.equal(compiled, expected);
    });
  });

  describe('resolveSkill', () => {
    it('loads skill body without frontmatter', () => {
      const skillsDir = makeDir('skills');
      writeFile('skills/my-skill/SKILL.md', '---\nname: my-skill\ndescription: test\n---\n\n# My Skill\n\nContent here.\n');
      const { body, accessScope } = resolveSkill('my-skill', skillsDir);
      assert.equal(body, '# My Skill\n\nContent here.');
      assert.equal(accessScope, null);
    });

    it('throws on missing skill', () => {
      const skillsDir = makeDir('skills');
      assert.throws(
        () => resolveSkill('nonexistent-skill', skillsDir),
        /not found/
      );
    });

    it('throws on invalid skill name (path traversal)', () => {
      const skillsDir = makeDir('skills');
      assert.throws(
        () => resolveSkill('../../etc/passwd', skillsDir),
        /Invalid skill name/
      );
    });

    it('extracts access scope marker and removes it from body', () => {
      const skillsDir = makeDir('skills');
      writeFile('skills/scoped-skill/SKILL.md',
        '---\nname: scoped-skill\n---\n\n***ACCESS SCOPE: write-access***\n\n# Scoped\n\nContent.\n');
      const { body, accessScope } = resolveSkill('scoped-skill', skillsDir);
      assert.equal(accessScope, 'write-access');
      assert.ok(!body.includes('ACCESS SCOPE'));
      assert.ok(body.includes('# Scoped'));
    });
  });

  describe('compileAgent', () => {
    it('compiles a single agent with skills', () => {
      const skillsDir = makeDir('skills');
      const outputDir = path.join(tmpDir, 'output');
      const dynamicDir = makeDir('dynamic');

      writeFile('skills/skill-a/SKILL.md',
        '---\nname: skill-a\ndescription: A\n---\n\n# Skill A\n\nAlpha content.\n');
      writeFile('skills/skill-b/SKILL.md',
        '---\nname: skill-b\ndescription: B\n---\n\n***ACCESS SCOPE: write-access***\n\n# Skill B\n\nBeta content.\n');

      const source = writeFile('dynamic/test-agent.md',
        '---\nname: test-agent\nmodel: opus\nskills:\n  - skill-a\n  - skill-b\n---\n\nThis is the agent body.\n');

      const { outputPath, compiledBody } = compileAgent(source, outputDir, skillsDir);

      assert.ok(fs.existsSync(outputPath));
      const compiled = fs.readFileSync(outputPath, 'utf-8');

      // Frontmatter should not have skills
      const { meta } = parseFrontmatter(compiled);
      assert.equal(meta['skills'], undefined);
      assert.equal(meta['name'], 'test-agent');
      assert.equal(meta['model'], 'opus');

      // Body should include agent body + both skills
      assert.ok(compiledBody.includes('This is the agent body.'));
      assert.ok(compiledBody.includes('# Skill A'));
      assert.ok(compiledBody.includes('# Skill B'));

      // Meta JSON sidecar
      const metaJson = JSON.parse(fs.readFileSync(path.join(outputDir, 'test-agent.meta.json'), 'utf-8'));
      assert.equal(metaJson['access-scope'], 'write-access');
    });

    it('warns and copies as-is when agent has no skills', () => {
      const skillsDir = makeDir('skills');
      const outputDir = path.join(tmpDir, 'output');

      const source = writeFile('dynamic/no-skills.md',
        '---\nname: no-skills\nmodel: opus\n---\n\nPlain body.\n');

      const { outputPath } = compileAgent(source, outputDir, skillsDir);
      assert.ok(fs.existsSync(outputPath));

      const compiled = fs.readFileSync(outputPath, 'utf-8');
      assert.ok(compiled.includes('Plain body.'));

      // Access scope defaults to read-only
      const metaJson = JSON.parse(fs.readFileSync(path.join(outputDir, 'no-skills.meta.json'), 'utf-8'));
      assert.equal(metaJson['access-scope'], 'read-only');
    });
  });

  describe('access scope ranking', () => {
    it('highest scope wins across multiple skills', () => {
      const skillsDir = makeDir('skills');
      const outputDir = path.join(tmpDir, 'output');

      writeFile('skills/read-skill/SKILL.md',
        '---\nname: read-skill\n---\n\n***ACCESS SCOPE: read-only***\n\nRead content.\n');
      writeFile('skills/build-skill/SKILL.md',
        '---\nname: build-skill\n---\n\n***ACCESS SCOPE: ubt-build-hook-interceptor***\n\nBuild content.\n');
      writeFile('skills/write-skill/SKILL.md',
        '---\nname: write-skill\n---\n\n***ACCESS SCOPE: write-access***\n\nWrite content.\n');

      const source = writeFile('dynamic/ranked.md',
        '---\nname: ranked\nskills:\n  - read-skill\n  - build-skill\n  - write-skill\n---\n\nBody.\n');

      compileAgent(source, outputDir, skillsDir);
      const metaJson = JSON.parse(fs.readFileSync(path.join(outputDir, 'ranked.meta.json'), 'utf-8'));
      assert.equal(metaJson['access-scope'], 'ubt-build-hook-interceptor');
    });

    it('SCOPE_RANK has correct ordering', () => {
      assert.ok(SCOPE_RANK['read-only'] < SCOPE_RANK['write-access']);
      assert.ok(SCOPE_RANK['write-access'] < SCOPE_RANK['ubt-build-hook-interceptor']);
    });
  });

  describe('findSubAgents', () => {
    it('finds referenced dynamic agents in compiled body', () => {
      const dynamicDir = makeDir('dynamic');
      writeFile('dynamic/container-implementer.md', '---\nname: impl\n---\n\nBody\n');
      writeFile('dynamic/container-reviewer.md', '---\nname: rev\n---\n\nBody\n');
      writeFile('dynamic/container-tester.md', '---\nname: test\n---\n\nBody\n');

      const body = 'Use container-implementer for code changes and container-tester for tests.';
      const result = findSubAgents(body, dynamicDir, new Set());

      assert.equal(result.length, 2);
      assert.ok(result.some(p => p.endsWith('container-implementer.md')));
      assert.ok(result.some(p => p.endsWith('container-tester.md')));
      // container-reviewer should NOT be matched
      assert.ok(!result.some(p => p.endsWith('container-reviewer.md')));
    });

    it('respects exclude set', () => {
      const dynamicDir = makeDir('dynamic');
      writeFile('dynamic/container-implementer.md', '---\nname: impl\n---\n\nBody\n');

      const body = 'Use container-implementer for code.';
      const result = findSubAgents(body, dynamicDir, new Set(['container-implementer']));
      assert.equal(result.length, 0);
    });

    it('does not match partial names', () => {
      const dynamicDir = makeDir('dynamic');
      writeFile('dynamic/impl.md', '---\nname: impl\n---\n\nBody\n');

      const body = 'The implementation is complete.';
      const result = findSubAgents(body, dynamicDir, new Set());
      assert.equal(result.length, 0);
    });
  });
});
