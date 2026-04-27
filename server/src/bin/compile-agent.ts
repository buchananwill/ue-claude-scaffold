#!/usr/bin/env node
/**
 * CLI entry point for the agent compiler.
 *
 * Accepts the same flags as the Python version:
 *   positional `source`, --all, -o/--output, --skills-dir, --dynamic-dir, --recursive, --clean
 *
 * Same console output format and exit codes as the Python version.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileAgent,
  compileAgentWithSubAgents,
  type CompiledAgent,
} from "../agent-compiler.js";

// Resolve repo root: this file lives at server/src/bin/compile-agent.ts
// At runtime (compiled): server/dist/bin/compile-agent.js
// Repo root is three levels up from the compiled location.
const SCRIPT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const DEFAULT_SKILLS_DIR = path.join(REPO_ROOT, "skills");
const DEFAULT_DYNAMIC_DIR = path.join(REPO_ROOT, "dynamic-agents");
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, ".compiled-agents");

interface ParsedArgs {
  source: string | null;
  all: boolean;
  output: string;
  skillsDir: string;
  dynamicDir: string;
  recursive: boolean;
  clean: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    source: null,
    all: false,
    output: DEFAULT_OUTPUT_DIR,
    skillsDir: DEFAULT_SKILLS_DIR,
    dynamicDir: DEFAULT_DYNAMIC_DIR,
    recursive: false,
    clean: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--all") {
      args.all = true;
    } else if (arg === "-o" || arg === "--output") {
      i++;
      if (i >= argv.length) {
        process.stderr.write(`Error: ${arg} requires a value\n`);
        process.exit(1);
      }
      args.output = argv[i];
    } else if (arg === "--skills-dir") {
      i++;
      if (i >= argv.length) {
        process.stderr.write(`Error: ${arg} requires a value\n`);
        process.exit(1);
      }
      args.skillsDir = argv[i];
    } else if (arg === "--dynamic-dir") {
      // Extension over Python: allows explicit directory for sub-agent discovery
      i++;
      if (i >= argv.length) {
        process.stderr.write(`Error: ${arg} requires a value\n`);
        process.exit(1);
      }
      args.dynamicDir = argv[i];
    } else if (arg === "--recursive") {
      args.recursive = true;
    } else if (arg === "--clean") {
      args.clean = true;
    } else if (arg.startsWith("-")) {
      process.stderr.write(`ERROR: unrecognized argument: ${arg}\n`);
      process.exit(1);
    } else {
      args.source = arg;
    }
    i++;
  }

  return args;
}

function printHelp(): void {
  process.stderr.write(
    "usage: compile-agent [-h] [source] [--all] [-o OUTPUT] [--skills-dir SKILLS_DIR] [--dynamic-dir DIR] [--recursive] [--clean]\n" +
      "\n" +
      "Compile dynamic agent definitions by injecting skill content.\n" +
      "\n" +
      "positional arguments:\n" +
      "  source                Path to a dynamic agent .md file\n" +
      "\n" +
      "options:\n" +
      "  --all                 Compile all dynamic agents in dynamic-agents/\n" +
      "  -o, --output OUTPUT   Output directory (default: .compiled-agents)\n" +
      "  --skills-dir DIR      Skills directory (default: skills/)\n" +
      "  --dynamic-dir DIR     Dynamic agents directory (default: dynamic-agents/)\n" +
      "  --recursive           Scan compiled lead agent for sub-agent references and compile those too (one level)\n" +
      "  --clean               Remove the output directory and exit\n",
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.clean) {
    const resolvedOutput = path.resolve(args.output);
    if (!resolvedOutput.startsWith(REPO_ROOT + path.sep)) {
      process.stderr.write(
        `ERROR: --output path must be within the repository\n`,
      );
      process.exit(1);
    }
    if (fs.existsSync(args.output)) {
      fs.rmSync(args.output, { recursive: true, force: true });
      console.log(`Removed ${args.output}`);
    } else {
      console.log(`Nothing to clean — ${args.output} does not exist`);
    }
    return;
  }

  // Ensure --output resolves to a path strictly inside the repository
  const resolvedOutput = path.resolve(args.output);
  if (!resolvedOutput.startsWith(REPO_ROOT + path.sep)) {
    process.stderr.write(
      "ERROR: --output path must be within the repository\n",
    );
    process.exit(1);
  }

  // Validate source path does not contain '..' to prevent path traversal
  if (args.source && args.source.includes("..")) {
    process.stderr.write("ERROR: source path must not contain '..'\n");
    process.exit(1);
  }

  let sources: string[];
  if (args.all) {
    if (!fs.existsSync(args.dynamicDir)) {
      process.stderr.write(`No dynamic agents found in ${args.dynamicDir}\n`);
      process.exit(1);
    }
    sources = fs
      .readdirSync(args.dynamicDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => path.join(args.dynamicDir, f));
    if (sources.length === 0) {
      process.stderr.write(`No dynamic agents found in ${args.dynamicDir}\n`);
      process.exit(1);
    }
  } else if (args.source) {
    sources = [args.source];
  } else {
    printHelp();
    process.exit(1);
    return; // unreachable but satisfies TS
  }

  const compiledNames = new Set<string>();
  const allSubAgents: CompiledAgent[] = [];
  const allWarnings: string[] = [];

  try {
    for (const src of sources) {
      if (args.recursive) {
        const result = compileAgentWithSubAgents(
          src,
          args.output,
          args.skillsDir,
          args.dynamicDir,
          compiledNames,
        );
        console.log(`  ${path.basename(src)} -> ${result.main.outputPath}`);
        allSubAgents.push(...result.subAgents);
        allWarnings.push(...result.warnings);
      } else {
        const { outputPath } = compileAgent(src, args.output, args.skillsDir);
        compiledNames.add(path.basename(src, ".md"));
        console.log(`  ${path.basename(src)} -> ${outputPath}`);
      }
    }

    if (allSubAgents.length > 0) {
      console.log(`\n  Sub-agents referenced in skills:`);
      for (const sub of allSubAgents) {
        console.log(`    ${sub.type}.md -> ${sub.outputPath}`);
      }
    }
    for (const w of allWarnings) {
      process.stderr.write(`  WARNING: ${w}\n`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ERROR: ${message}\n`);
    process.exit(1);
  }

  const total = sources.length + allSubAgents.length;
  console.log(`\nCompiled ${total} agent(s) to ${args.output}`);
}

main();
