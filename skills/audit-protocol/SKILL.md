---
name: audit-protocol
description: Use when an agent must audit a codebase area and produce documentation. Defines the audit workflow — scope the area, read code and existing docs, trace composition, write new markdown deliverables. Never edit existing code files.
---

# Audit Protocol

Base protocol for documentation audit agents. Every audit follows this sequence.

## Action Boundary

- **Read**: source code files, headers, data asset declarations, existing documentation, config files.
- **Write**: new markdown files only. Place deliverables in a location specified by the launch prompt.
- **Never**: edit, delete, or rename existing code files (.h, .cpp, .cs, .ini, .uasset references). If you find a code defect, document it in the deliverable — do not fix it.

## Evidence Discipline

Every claim in a deliverable must be either:

- **Structural fact** — directly observable in code (a type exists, a function calls another function, a name is registered). Cite the file and symbol.
- **Quoted semantics** — meaning stated in a code comment, doc string, constant name, or enum label. Quote the source.

If the meaning, purpose, or ordering of a value is not explicitly stated in the source material, do not guess. Write: "the meaning/purpose/ordering of X is not documented in the source." Never fill gaps with plausible-sounding interpretations.

## Steps

### Step 1: Scope the Audit Area

Identify the module, directory, or subsystem boundary from the launch prompt. Use `Glob` and `Grep` to enumerate the relevant source files, headers, and any existing documentation.

### Step 2: Read and Trace

For each file in scope:
1. Read the complete file — not just declarations.
2. Trace how types, assets, and configuration objects are composed — who creates them, who consumes them, what the runtime lookup path is.
3. Follow cross-references into dependent modules and engine headers as needed.

Build a mental model of the composition tree before writing anything.

### Step 3: Write Deliverables

Produce the markdown deliverable(s) specified by the launch prompt. Commit each deliverable as a separate commit with a descriptive message. Flag any discovered gaps, dead wiring, unreachable configurations, or undocumented composition paths as structured elements within the deliverable.
