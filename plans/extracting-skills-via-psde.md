# Cross-Agent Pattern Recognition

### IDENTICAL concerns appearing in multiple agents

| Concern                                                                       | Axis        | Agents                                    | Notes                                                                                                                                                     |
|-------------------------------------------------------------------------------|-------------|-------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------|
| Read-only action boundary                                                     | P           | style, safety, correctness, decomposition | All four reviewers declare they never modify files                                                                                                        |
| "Does NOT review" mandate exclusion                                           | P           | style, safety, correctness, decomposition | Each reviewer scopes out what it *won't* check — same structural pattern, different content                                                               |
| Review process sequence (identify → read → check → score)                     | P           | style, safety, correctness, decomposition | Same base steps with per-reviewer variations (safety adds "read dependencies", correctness adds "validate spec", decomposition adds "measure + coupling") |
| Critical rules section                                                        | P           | style, safety, correctness, decomposition | Same structural pattern: read-only, stay in lane, be specific. Meta-cognitive action validity                                                             |
| Completion rule: last action = successful build                               | P           | implementer, tester                       | "Any edit after build invalidates it" — same temporal constraint                                                                                          |
| Implementation loop (read → modify → build → iterate)                         | P           | implementer, tester                       | Same core sequence; tester's variation is scoped to test directories                                                                                      |
| Meta-cognitive validity rules (follow plan, don't add extras, flag ambiguity) | P           | implementer, orchestrator                 | Same "what kinds of actions are allowed" discipline                                                                                                       |
| Scoring rubric (75+/90+/below 75 → WARNING/BLOCKING/skip)                     | S           | style, safety, correctness, decomposition | Identical classification thresholds and severity labels                                                                                                   |
| Output template (BLOCKING/WARNING/Summary/Verdict)                            | S           | style, safety, correctness, decomposition | Same base structure; correctness adds Specification Compliance, decomposition adds proposed split table                                                   |
| UE C++ style truths (East-const, IWYU, Allman, BOM, etc.)                     | D           | implementer, tester, style-reviewer       | Identical style knowledge loaded into three agents                                                                                                        |
| Project-specific Key Patterns (FBuildableActorModel, CrowdField, scheduler)   | D (project) | safety, correctness                       | Identical project truth sections                                                                                                                          |
| Defensive Macros (UE_RETURN_IF_INVALID)                                       | D (project) | safety, correctness                       | Same project-specific truth                                                                                                                               |
| Container build hook routing / UBT queue                                      | E           | implementer, tester, orchestrator         | Truth about how builds route through the coordination server                                                                                              |

### Concerns that are UNIQUE to one agent

| Agent                      | Unique Concerns                                                                                                                                                                                                                                                                                 | Axis               |
|----------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------|
| **orchestrator**           | Phase execution protocol (4 phases + sub-steps), agent resolution table, message board protocol, verbosity levels, parallel review dispatch, cycle budget (max 5), context discipline, error escalation schema, boy scout rule timing                                                           | P, E, S            |
| **decomposition-reviewer** | Responsibility group definitions, nesting depth analysis (2/3/4+ levels), "extraction is free" (unity builds, FORCEINLINE), lifetime-informed decomposition, comments as decomposition signals, proposed split table output, decomposition constraints (mechanical, no rename, no logic change) | D, S               |
| **tester**                 | Test naming convention (Resort.*), EAutomationTestFlags, test file structure, test pattern template, helper catalog (MakeTestModel, PoisonFloat, MakeSquareTileGrid…), category-specific test guidance (Buildable, CrowdField, Behaviour, Mass Entity)                                          | S, D (project)     |
| **correctness-reviewer**   | Spec compliance checks, implicit vs explicit semantics (FName), invariant preservation (ComponentModels/Transforms alignment, tree symmetry, GUID), Mass ECS correctness (FMassEntityQuery, processors, entity handles), test coverage gap analysis                                             | D                  |
| **style-reviewer**         | UE prefix naming (F/U/A/E/I/T/b), closure rules (explicit captures, named lambdas, no IIFE), magic literals → named constants, TEXT() macro, TFunction vs std::function, TArray vs std::vector, dead code detection                                                                             | D (UE + universal) |
| **safety-reviewer**        | GC safety (dangling TObjectPtr, raw pointers across GC, missing UPROPERTY, NewObject rooting, ConditionalBeginDestroy), thread safety (shared state, game thread, async captures, FSynced), move semantics (MoveTemp on const, use-after-move, MoveTemp on UPROPERTY)                           | D (UE)             |

---

## Emerging Skill Candidates (by axis)

### Protocol (P)

| ID | Skill                          | Used by                                   | Description                                                                                                                                                                                                                                           |
|----|--------------------------------|-------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| P1 | **review-process**             | style, safety, correctness, decomposition | Base review sequence: identify changed files → read full context → check against domain criteria → score. Each reviewer extends with its own variation step.                                                                                          |
| P2 | **implementation-loop**        | implementer, tester                       | Read → modify → build → iterate until green. Completion = last action is a successful build; any edit after build invalidates it.                                                                                                                     |
| P3 | **action-boundary-discipline** | all reviewers, orchestrator, implementer  | Meta-cognitive validity: defines what actions are allowed/forbidden for the active role. Includes read-only enforcement, mandate exclusions, "don't add extras", "flag ambiguity".                                                                    |
| P4 | **orchestration-protocol**     | orchestrator                              | Phase execution: parse plan → delegate to sub-agents → evaluate results → cycle (max 5) → commit → decomposition review. Includes parallel dispatch, boy scout rule, context discipline. Unique to orchestrator but large enough to be its own skill. |

### Domain Knowledge (D)

| ID | Skill                      | Used by                             | Scope                                                                                                                                                                                                     |
|----|----------------------------|-------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| D1 | **ue-cpp-style**           | implementer, tester, style-reviewer | UE C++ style truths: East-const, PascalCase, IWYU, Allman braces, TObjectPtr, UE type preferences (TFunction, TArray), prefix naming, BOM, closure rules, magic literals, TEXT()                          |
| D2 | **ue-safety**              | safety-reviewer                     | UE safety truths: GC rooting, dangling TObjectPtr, raw pointers across GC, move semantics, thread safety, game thread assumptions, ConditionalBeginDestroy                                                |
| D3 | **ue-correctness**         | correctness-reviewer                | Correctness truths: spec compliance methodology, implicit/explicit semantics, off-by-one boundaries, null checks, operator correctness, test coverage gaps                                                |
| D4 | **ue-decomposition**       | decomposition-reviewer              | Decomposition truths: responsibility thresholds (300/500 lines), extraction cost model (unity builds, FORCEINLINE), lifetime-informed splitting, nesting depth, comments as split signals, DRY violations |
| D5 | **project-patterns**       | safety, correctness, (tester)       | Project-specific truths: FBuildableActorModel, CrowdField, ForEachCell, TileArenaIndex, behaviour scheduler, defensive macros (UE_RETURN_IF_INVALID)                                                      |
| D6 | **project-test-knowledge** | tester                              | Project-specific test truths: helper catalog, category-specific guidance, test naming conventions                                                                                                         |
| D7 | **quality-philosophy**     | orchestrator                        | Senior Tech Lead stance: criticize, don't rubber-stamp, push standards, no unearned praise. Could be shared across review roles but currently only in orchestrator.                                       |

### Schema (S)

| ID | Skill                           | Used by                                   | Description                                                                                                                                                            |
|----|---------------------------------|-------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| S1 | **review-output-schema**        | style, safety, correctness, decomposition | Scoring rubric (75+/90+/<75), severity labels (BLOCKING/WARNING), output template (findings → summary → verdict). Each reviewer extends with domain-specific sections. |
| S2 | **implementation-io-schema**    | implementer                               | Input shape: plan or fix instructions. Output template: Changes / Build Status / Notes.                                                                                |
| S3 | **orchestration-output-schema** | orchestrator                              | Final summary template, error escalation schema, phase reporting format, message board post schemas.                                                                   |
| S4 | **test-format-schema**          | tester                                    | Test naming (Resort.*), EAutomationTestFlags, file structure convention, test pattern template.                                                                        |

### Environment (E)

| ID | Skill                           | Used by                                   | Description                                                                                                                                                            |
|----|---------------------------------|-------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------|

---

## Observations

1. **The four reviewers share ~60% of their structure.** P1 (review-process), P3 (action-boundary-discipline), and S1 (
   review-output-schema) together form a "reviewer chassis" that all four reviewers build on. Each reviewer then layers
   its own D-axis knowledge. This is the strongest case for skill extraction — the shared protocol and schema are
   currently copy-pasted four times.

2. **D-axis skills have clean boundaries.** Each reviewer's domain knowledge is genuinely orthogonal: style ≠ safety ≠
   correctness ≠ decomposition. This validates the original design intuition about composable, narrow-mandate reviewers.

3. **Implementer and tester share a protocol but differ in scope.** P2 (implementation-loop) is the same process — the
   only difference is that tester is scoped to test directories. This suggests a single protocol skill with a scope
   parameter, not two separate skills.

4. **Environment (E) concerns are scattered, not shared.** Container build routing appears in three agents but is really
   one fact ("builds go through the coordination server") restated differently each time. This is a strong candidate for
   a single E-axis instruction file (already partially exists as `00-build-loop.md`).

5. **Project-specific D knowledge is duplicated between safety and correctness reviewers.** D5 (project-patterns)
   appears almost identically in both — the Key Patterns and Defensive Macros sections are copy-pasted. This should be a
   single shared skill.

6. **The orchestrator is mostly unique.** Its protocol (P4) and schema (S3) are not shared with any other agent. It
   shares P3 (action-boundary-discipline) conceptually but with very different content. The orchestrator is the ***currently*** the least
   amenable to decomposition into shared skills. It is a composition layer that can't yet be composed or decomposed.

7. **Skill count is manageable.** 4 P-skills + 7 D-skills + 4 S-skills = 15 candidates. Several of these (P4, S3, D6,
   D7) are single-agent, meaning they might remain inline rather than extracted. The high-value extractions are the
   shared ones: P1+S1 (reviewer chassis), D1 (UE style), P2 (implementation loop), D5 (project patterns).

