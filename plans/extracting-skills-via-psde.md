# Cross-Agent Pattern Recognition

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
