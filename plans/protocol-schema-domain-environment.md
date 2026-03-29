# Protocol, Schema, Domain, Environment: Empirical Dimensional Analysis of Container Agents

> Edits are indicated like this: ~~original text~~ ***my edit***

## The ~~Three~~ ***Four*** Axes

In order to build composable, concise, rigorous agent skills, we define the following four dimensions of skill scoping,
from most generalized, to most specific:

> - **Protocol** (P): process sequences, temporal flow. "Do X, then Y, then Z." These are very often true across
    multiple
    languages, projects, problem domains and execution environments.
> - **Schema** (S): patterns and structures that must be adhered to. Formats, boundaries, constraints. These prime the
    agent for how to interpret prompts and return responses consistently. More likely to be influenced by language
    syntaxes or project domains, but often general too (e.g. markdown, yml and JSON as ubiquitous standards).
> - **Domain Knowledge** (D): True/false, valuable/worthless, effective/weak. These can vary in how generalized they
    are,
    from C++ syntax (the language has strict compilation rules) to Unreal Engine idioms (PascalCase or UObject GC and
    reflection), or even project specific, such as preferred libraries, code styles or proprietary APIs.
>- **Environment** (E): system environment context that the agent needs, e.g. where to find certain files, or whether a
   particular tool or executable is available (e.g. python, node, SQLite, UBT). The most specific: an agent might work
   on
   the same project in different locations, and this dimension of knowledge is the ***most brittle***.

---

## Per-Agent Concern Inventory

### container-implementer.md

| Line(s) | Concern                                              | Axis                | Notes                                                                                                                                  |
|---------|------------------------------------------------------|---------------------|----------------------------------------------------------------------------------------------------------------------------------------|
| 12-17   | Build hooks route to Windows host, queue behaviour   | ~~D~~ ***E***       | Truth about container infrastructure                                                                                                   |
| 13      | `python Scripts/build.py --summary`                  | D (project)         | Specific build command                                                                                                                 |
| 14      | "Do NOT skip the build"                              | ~~D~~ ***E***       | Truth about what's required in this env                                                                                                |
| 21      | "Load ue-cpp-style skill before writing"             | ~~P~~ ***D***       | ~~Temporal ordering~~ ***Agent FM injects skill***                                                                                     |
| 22-28   | East-const, TObjectPtr, IWYU, Allman braces, BOM     | D (UE language)     | UE C++ style truths                                                                                                                    |
| 32-33   | Input: plan or fix instructions                      | S                   | Input shape ***Yes good addition: schemas are how to interpret inputs as well as outputs***                                            |
| 38-44   | Steps 1-7: read → modify → build → iterate           | P                   | Core implementation sequence                                                                                                           |
| 46-49   | Completion rule: last action = successful build      | P                   | Temporal constraint                                                                                                                    |
| 46      | "Any commit after build invalidates it"              | ~~D~~ ***P***       | Truth about validation (should be "any edit")                                                                                          |
| 57-71   | Output template (Changes/Build Status/Notes)         | S                   | Output structure                                                                                                                       |
| 75-79   | Rules: follow plan, don't add extras, flag ambiguity | ~~D (universal)~~ P | ~~Quality truths~~ ***Protocol is not just a specific sequence, it's also meta-cognition about what kind of action sequences are valid |

### container-style-reviewer.md

| Line(s) | Concern                                               | Axis               | Notes                                                                                                         |
|---------|-------------------------------------------------------|--------------------|---------------------------------------------------------------------------------------------------------------|
| 9-10    | Read-only, never modify files                         | ~~S~~ ***P***      | Role boundary                                                                                                 |
| 12-14   | Does NOT review: correctness, safety, test coverage   | ~~S~~ ***D***      | Mandate exclusion ***domain: we're scoping what knowledge the is within the agent's concern***                |
| 20      | "Load ue-cpp-style FIRST"                             | ~~P~~              | ~~Temporal ordering~~ **Agent Front Matter**                                                                  |
| 24-30   | Lint hook catches these patterns (East-const, etc.)   | ~~D~~ ***E***      | Truth about what's already enforced                                                                           |
| 35-38   | UE prefix naming (F/U/A/E/I/T/b)                      | D (UE language)    | UE naming truths                                                                                              |
| 39-40   | PascalCase, no m_, Out prefix                         | D (UE language)    | UE naming truths                                                                                              |
| 42-45   | IWYU, forward declarations, include order             | D (C++)            | C++ include truths                                                                                            |
| 47-49   | Allman braces, mandatory braces, no redundant else    | D (style)          | Formatting truths (partially universal)                                                                       |
| 51-54   | One decl per line, East-const, auto usage, TObjectPtr | D (UE language)    | Mixed universal + UE                                                                                          |
| 56-59   | Explicit captures, named lambdas, no IIFE             | D (C++)            | C++ closure truths                                                                                            |
| 61-65   | Magic literals → named constants, TEXT() macro        | D (universal + UE) | Universal truth + UE-specific                                                                                 |
| 67-69   | TFunction vs std::function, TArray vs std::vector     | D (UE language)    | UE type preference truths                                                                                     |
| 71-73   | Commented-out code, disabled #if 0                    | D (universal)      | Universal dead code truth                                                                                     |
| 76-79   | UPROPERTY/UFUNCTION/UCLASS specifiers, GENERATED_BODY | D (UE language)    | UE macro truths                                                                                               |
| 86-92   | Steps 1-4: identify files → read → check → score      | P                  | Review process sequence                                                                                       |
| 98-104  | Scoring: 75+/90+/below 75 → WARNING/BLOCKING/skip     | S                  | Classification rubric                                                                                         |
| 104     | "All WARNINGs treated as blocking by orchestrator"    | ~~D (system)~~     | Leaked orchestrator concern ***Brittle: child agent should not concern itself with protocol it doesn't own*** |
| 108-132 | Output template (BLOCKING/WARNING/Summary/Verdict)    | S                  | Output structure                                                                                              |
| 134-141 | Critical rules: read-only, stay in lane, be specific  | ~~S + D~~          | ~~Role boundaries + quality truths~~ ***Protocol: meta-cognitive action validity.***                          |

### container-safety-reviewer.md

| Line(s) | Concern                                                                                                                               | Axis               | Notes                                                              |
|---------|---------------------------------------------------------------------------------------------------------------------------------------|--------------------|--------------------------------------------------------------------|
| 10-11   | Read-only                                                                                                                             | S                  | Role boundary (SAME as style)                                      |
| 14-16   | Does NOT review: style, spec compliance                                                                                               | S                  | Mandate exclusion (SAME pattern)                                   |
| 20      | "Find code that compiles but will crash/race/leak"                                                                                    | D (universal)      | What safety review IS                                              |
| 24-33   | Dangling TObjectPtr, raw pointers across GC, MoveTemp, cycles, stack escaping, container invalidation, std::function in UE containers | D (UE language)    | UE-specific safety truths                                          |
| 36-40   | Missing UPROPERTY, NewObject rooting, ConditionalBeginDestroy, AddReferencedObjects                                                   | D (UE language)    | UE GC truths                                                       |
| 42-47   | Shared state mutations, game thread assumptions, async captures, FSynced access                                                       | D (UE + universal) | Thread safety truths (mixed)                                       |
| 49-54   | MoveTemp on const, use after move, unnecessary MoveTemp, MoveTemp on UPROPERTY                                                        | D (UE language)    | UE move semantics truths                                           |
| 58-76   | Steps 1-4: identify → read + dependencies → analyse → score                                                                           | P                  | Review process (SAME as style, with "read dependencies" variation) |
| 80-86   | Scoring rubric                                                                                                                        | S                  | SAME as style reviewer                                             |
| 90-117  | Output template                                                                                                                       | S                  | SAME structure, different category labels                          |
| 119-125 | Key Patterns (FBuildableActorModel, CrowdField, behaviour scheduler)                                                                  | D (project)        | Project-specific truths                                            |
| 127-129 | Defensive Macros (UE_RETURN_IF_INVALID)                                                                                               | D (project)        | Project-specific truths                                            |
| 130-137 | Critical rules                                                                                                                        | S + D              | SAME pattern as style reviewer                                     |

### container-reviewer.md (correctness)

| Line(s) | Concern                                                                                 | Axis               | Notes                                                     |
|---------|-----------------------------------------------------------------------------------------|--------------------|-----------------------------------------------------------|
| 10-11   | Read-only                                                                               | S                  | SAME                                                      |
| 14-16   | Does NOT review: style, memory safety                                                   | S                  | SAME pattern                                              |
| 19      | Receives spec + changes, verifies compliance                                            | D (universal)      | What correctness review IS                                |
| 24-30   | Spec compliance checks                                                                  | P + D              | How to check (P) + what matters (D)                       |
| 32-42   | Off-by-one, boundaries, logic errors, null checks, operators                            | D (universal)      | Universal programming truths                              |
| 44-48   | Implicit vs explicit semantics (FName example)                                          | D (universal + UE) | Universal truth with UE example                           |
| 50-56   | Invariant preservation (ComponentModels/Transforms alignment, tree symmetry, GUID)      | D (project)        | Project-specific invariant truths                         |
| 57-63   | Mass ECS correctness (FMassEntityQuery, processors, entity handles)                     | D (UE framework)   | UE framework truths                                       |
| 65-70   | Test coverage gaps                                                                      | D (universal)      | Universal testing truth                                   |
| 73-98   | Steps 1-5: identify → read full context → validate spec → check dimensions → score      | P                  | Review process (SAME base, with "validate spec" addition) |
| 100-107 | Scoring rubric                                                                          | S                  | SAME                                                      |
| 110-147 | Output template (adds Specification Compliance section)                                 | S                  | SAME base + spec compliance section                       |
| 149-157 | Key Patterns (FBuildableActorModel, CrowdField, ForEachCell, TileArenaIndex, scheduler) | D (project)        | Project-specific truths                                   |
| 159-162 | Defensive Macros                                                                        | D (project)        | Project-specific truths                                   |
| 164-170 | Critical rules (adds: cross-reference spec, cross-reference tests)                      | S + D              | SAME pattern + correctness-specific                       |

### container-decomposition-reviewer.md

| Line(s) | Concern                                                                                                                           | Axis               | Notes                                                    |
|---------|-----------------------------------------------------------------------------------------------------------------------------------|--------------------|----------------------------------------------------------|
| 10-11   | Read-only                                                                                                                         | S                  | SAME                                                     |
| 12-13   | Does NOT review: spec compliance, style                                                                                           | S                  | SAME pattern                                             |
| 15-22   | DO consider: lifetime boundaries, thread safety, GC rooting visibility                                                            | D (C++ + UE)       | Decomposition-relevant truths                            |
| 24-29   | Thresholds: 300/500 lines + multiple responsibilities                                                                             | D (universal)      | Heuristic truths about file size                         |
| 31-37   | What Counts as Responsibility Group (UCLASS, USTRUCT, free functions, algorithms, BlueprintCallable, Mass processor, type blocks) | D (UE + universal) | Mixed                                                    |
| 39-45   | DRY violations, semantic inversions                                                                                               | D (universal)      | Universal code quality truths                            |
| 47-56   | Hand-rolled algorithms (Algo::LowerBoundBy, RemoveAll, etc.)                                                                      | D (UE + universal) | Library awareness (UE examples)                          |
| 59-65   | Extraction Is Free (Unity builds, modern compilers, FORCEINLINE)                                                                  | D (C++ + UE)       | Performance truths                                       |
| 67-77   | Comments as decomposition signals                                                                                                 | D (universal)      | Universal structural truth                               |
| 79-96   | Nesting depth (2/3/4+ levels, causes, remediation)                                                                                | D (universal)      | Universal structural truth                               |
| 98-115  | Lifetime-informed decomposition (for/against, UPROPERTY chains, GC, thread safety)                                                | D (C++ + UE)       | Ownership truths with UE specifics                       |
| 117-125 | Decomposition rules: mechanical, follow patterns, no rename, no logic change                                                      | S                  | Constraints on decomposition output                      |
| 127-167 | Review Protocol Steps 1-5                                                                                                         | P                  | Review process (SAME base + measure + coupling analysis) |
| 159-167 | Scoring rubric                                                                                                                    | S                  | SAME pattern                                             |
| 169-214 | Output template (responsibility groups, lifetime analysis, proposed split table)                                                  | S                  | Unique, more detailed                                    |
| 216-224 | Critical rules                                                                                                                    | S + D              | SAME pattern                                             |

### container-tester.md

| Line(s) | Concern                                                                                          | Axis            | Notes                                              |
|---------|--------------------------------------------------------------------------------------------------|-----------------|----------------------------------------------------|
| 10-11   | May ONLY write to test directories                                                               | S               | Role boundary (different from reviewers)           |
| 13-19   | Container build/test environment, hook routing, queue                                            | ~~D~~ ***E***   | SAME as implementer                                |
| 22-28   | ue-cpp-style, East-const, explicit captures, braces, BOM                                         | D (UE language) | SAME as implementer                                |
| 30-74   | Test naming (Resort.*), flags (EAutomationTestFlags), file structure, test pattern template      | S + D (project) | Project-specific test format + truths              |
| 77-99   | Existing helper catalog (MakeTestModel, PoisonFloat, MakeSquareTileGrid, etc.)                   | D (project)     | Project-specific helper truths                     |
| 101-120 | Category-specific guidance (Buildable, CrowdField, Behaviour, Mass Entity)                       | D (project)     | Project-specific testing truths                    |
| 126-133 | Workflow steps 1-8: read tests → read helpers → read code → write → build → fix → style → report | P               | Implementation sequence (variation of implementer) |
| 135-136 | Completion rule: last action = successful build                                                  | P               | SAME as implementer                                |
| 138-143 | Critical rules: test dirs only, no prod code, read helpers, verify build                         | S + D           | Role boundaries + quality truths                   |

### container-orchestrator.md

| Line(s) | Concern                                                                                 | Axis          | Notes                               |
|---------|-----------------------------------------------------------------------------------------|---------------|-------------------------------------|
| 9-10    | Never write code, edit files, run builds                                                | S             | Role boundary                       |
| 12-16   | Responsibilities: parse plan, delegate, evaluate, post progress, summarise              | S             | Role definition                     |
| 20-35   | Senior Tech Lead: criticize, don't rubber-stamp, push standards, no unearned praise     | D (universal) | Quality philosophy                  |
| 37-51   | Autonomous rules: never wait, never stop, must build before review, one phase at a time | P + D         | Process constraints + system truths |
| 44-45   | "PreToolUse hook intercepts build/test commands"                                        | ~~D~~ ***E*** | Container environment truth         |
| 53-67   | Agent Resolution table (role → agent name mapping)                                      | S             | Delegation structure                |
| 66-67   | "CLAUDE.md may override these"                                                          | D (system)    | System configuration truth          |
| 68-71   | "Review agents have narrow mandates"                                                    | D (system)    | System design truth                 |
| 79-81   | Message board = only communication channel                                              | D (system)    | System architecture truth           |
| 83-91   | Mandatory posts: phase_start/complete, reviewer outputs, decomp, summary                | S             | Required message schema             |
| 93-115  | Verbosity levels: quiet/normal/verbose                                                  | S             | Post density schema                 |
| 119-209 | Phase Execution Protocol (4 steps + sub-steps)                                          | P             | Core orchestration sequence         |
| 131-133 | "When touching a file, fix style violations"                                            | D (universal) | Quality truth (boy scout rule)      |
| 143-145 | Parallel review (3 reviewers simultaneously)                                            | P             | Concurrency protocol                |
| 158-170 | Consolidate findings → single fix batch → re-review                                     | P             | Fix/re-review cycle                 |
| 172-179 | Cycle budget: max 5 review cycles                                                       | P             | Termination condition               |
| 188-206 | Commit verification (clean working tree, verify scope)                                  | P             | Verification sequence               |
| 211-258 | Final Stage: decomposition review                                                       | P             | Post-phases protocol                |
| 264-278 | Context Discipline: maintain plan + phase ID only                                       | S             | What orchestrator holds/doesn't     |
| 280-287 | Error Escalation: what to include on failure                                            | S             | Failure output schema               |
| 289-315 | Final Output template                                                                   | S             | Summary output structure            |

---

## Cross-Agent Pattern Recognition

### IDENTICAL concerns appearing in multiple agents

**Shared by ALL 4 reviewers (style, safety, correctness, decomposition):**

- Read-only constraint (S)
- Mandate exclusion pattern: "you do NOT review for X, Y" (S)
- Review process skeleton: identify files → read → analyse → score (P)
- Scoring rubric: 75+/90+/below 75 (S)
- Output structure: BLOCKING → WARNING → NOTE → Summary → Verdict (S)
- Critical rules pattern: read-only, stay in lane, be specific, evidence required (S + D)
- "All WARNINGs are treated as blocking" (D: leaked orchestrator concern)

**Shared by implementer + tester:**

- Container build environment description (D: environment)
- Style conformance requirement (D: language reference)
- Build-verify-iterate cycle (P)
- Completion rule: last action = successful build, any edit invalidates (P)
- "Do NOT skip the build" (D: environment)

**Shared by correctness + safety + decomposition reviewers:**

- "Key Patterns in This Codebase" section (D: project-specific)
- "Defensive Macros" section (D: project-specific)

### Concerns that are UNIQUE to one agent

**Orchestrator only:**

- Phase execution protocol (P)
- Delegation patterns and what to include per sub-agent (S)
- Quality philosophy / senior tech lead identity (D)
- Message board protocol and verbosity levels (P + S)
- Context discipline (S)
- Agent resolution table (S)

**Decomposition reviewer only:**

- File size thresholds (D)
- Responsibility group taxonomy (D)
- DRY violations / semantic inversions (D)
- Hand-rolled algorithms (D)
- Extraction Is Free (D)
- Comments as decomposition signals (D)
- Nesting depth analysis (D)
- Lifetime-informed decomposition (D)
- Decomposition rules: mechanical only, no rename, no logic change (S)

**Tester only:**

- Test-dirs-only write restriction (S)
- Test conventions / framework patterns (S + D)
- Helper catalog (D)
- "NEVER modify production code" (S)

---

## Emerging Skill Candidates (by axis)

### Protocol (P)

| ID | Skill                        | Used by                                | Description                                                                     |
|----|------------------------------|----------------------------------------|---------------------------------------------------------------------------------|
| P1 | Code review process          | All 4 reviewers                        | identify → read → analyse → score → output                                      |
| P2 | Build-verify cycle           | Implementer, Tester                    | build → check → iterate (max N) → completion rule                               |
| P3 | Orchestrator phase execution | Orchestrator                           | phase_start → delegate → parallel review → consolidate → fix → commit → advance |
| P4 | Message board posting        | Orchestrator (+ standing instructions) | When/how to post, mandatory posts                                               |

### Domain Knowledge (D)

| ID  | Skill                        | Used by                               | Scope                                                               |
|-----|------------------------------|---------------------------------------|---------------------------------------------------------------------|
| D1  | UE C++ conventions           | Implementer, Style reviewer, Tester   | East-const, TObjectPtr, IWYU, naming, macros                        |
| D2  | UE safety patterns           | Safety reviewer                       | GC rooting, MoveTemp, UObject lifetime, TSharedPtr                  |
| D3  | UE correctness patterns      | Correctness reviewer                  | Mass ECS, aligned array invariants                                  |
| D4  | UE test patterns             | Tester                                | Automation framework, helpers, categories                           |
| D5  | Container environment        | Implementer, Tester, Orchestrator     | Build hooks, queue, host routing                                    |
| D6  | Quality philosophy           | Orchestrator                          | Rigor, no rubber-stamping, standards                                |
| D7  | Decomposition principles     | Decomposition reviewer                | Thresholds, DRY, nesting, extraction, comments as signals, lifetime |
| D8  | Project-specific patterns    | Correctness, Safety, Decomp reviewers | FBuildableActorModel, CrowdField, defensive macros                  |
| D9  | Universal correctness truths | Correctness reviewer                  | Off-by-one, boundaries, implicit/explicit, invariants               |
| D10 | Universal safety truths      | Safety reviewer                       | Dangling refs, use-after-free, thread safety, ownership             |

### Schema (S)

| ID | Skill                                    | Used by         | Description                                                |
|----|------------------------------------------|-----------------|------------------------------------------------------------|
| S1 | Review output format + scoring           | All 4 reviewers | BLOCKING/WARNING/NOTE, 75+/90+, Verdict                    |
| S2 | Role boundaries                          | All agents      | Read-only, mandate exclusions, write restrictions          |
| S3 | Implementer output format                | Implementer     | Changes Made / Build Status / Notes                        |
| S4 | Orchestrator output + delegation schemas | Orchestrator    | Summary format, delegation content, verbosity, agent table |
| S5 | Test conventions schema                  | Tester          | Test file structure, naming patterns                       |

---

## Observations

1. **The review base is remarkably uniform.** Four agents share the same protocol, scoring, output structure, and
   critical rules. The only variation is what dimensions they analyse and minor protocol tweaks (safety reads
   dependencies, style doesn't).

2. **D1-D4 are the UE-specific axis.** Replacing these with TypeScript equivalents (or any language) gives you a
   complete language swap. Everything else is either universal or environment-specific.

3. **D5 (container environment) is independent of language.** It's about WHERE you build, not WHAT you build. A
   TypeScript project in the same container infrastructure would use the same D5.

4. **D7 (decomposition principles) is almost entirely universal.** The only UE-specific bits are examples (Algo::
   LowerBoundBy, Unity builds, UPROPERTY chains). The principles themselves (thresholds, DRY, nesting, comments as
   signals) transcend language.

5. **D8 (project-specific patterns) is the most volatile.** It changes per-project, not just per-language. The "Key
   Patterns in This Codebase" sections are essentially project memory.

6. **The orchestrator is mostly P + S.** Its domain knowledge is quality philosophy (D6) and system awareness (D5).
   Everything else is process sequencing and structural schemas.

7. **"All WARNINGs are treated as blocking" appears in every reviewer but is the orchestrator's policy.** It leaked
   downstream. The reviewers should report findings at their own confidence levels; the orchestrator decides how to
   triage.
