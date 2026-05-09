---

# Phase 6 — Parallel reviewer dispatch and mechanical consolidation

Part of [Plan: Durable Task FSM and Parallel Role Sessions](./_index.md). See the index for the shared goal and context — this phase body assumes them.

**Files:**
- `container/lib/run-claude.sh`
- `container/lib/reviewer-fanout.sh` (new)
- `skills/review-output-schema/SKILL.md` (the canonical source of the BLOCKING/WARNING/NOTE template, the verdict logic, and the "All WARNINGs are treated as blocking" boilerplate; composed into every reviewer agent — editing here is what actually drops the WARNING tier)
- `dynamic-agents/container-safety-reviewer-ue.md`, `dynamic-agents/container-reviewer-ue.md`, `dynamic-agents/container-decomposition-reviewer-ue.md` (structured-findings JSON output instructions; any reviewer-specific text that referenced WARNINGs)
- `.compiled-agents/*.md` regenerated automatically

**Work:**
1. After the `built → reviewing` transition, the daisy-chain calls `reviewer-fanout.sh <task-id> <cycle>`.
2. `reviewer-fanout.sh`:
   ```
   # Reviewer set comes from the resolved per-task agent-roles (Phase 4 step 2a).
   # All declared reviewers run every cycle in parallel — no terminal-cycle special-casing.
   declared_roles=$(jq -r '.reviewers | keys[]' <<< "$EFFECTIVE_AGENT_ROLES")

   # Recovery: skip reviewers that already posted a row for this (task, cycle).
   already_posted=$(curl -s "${SERVER_URL}/tasks/${task_id}/reviews/${cycle}" \
                    | jq -r '.runs[].reviewerRole')
   ROLES=()
   for role in $declared_roles; do
     if ! grep -qx "$role" <<< "$already_posted"; then
       ROLES+=("$role")
     fi
   done

   for role in "${ROLES[@]}"; do
     run-claude.sh "reviewer-$role" "$task_id" "$cycle" \
       > ".scratch/reviews/$task_id/cycle-$cycle/$role.md.tmp" &
   done
   wait
   for role in "${ROLES[@]}"; do
     mv ".scratch/reviews/$task_id/cycle-$cycle/$role.md.tmp" \
        ".scratch/reviews/$task_id/cycle-$cycle/$role.md"
   done
   ```
   Atomic rename guards against partial-write on crash mid-session. The recovery skip means re-entering `reviewing` after a partial-progress crash only re-fans-out the missing reviewers — the already-posted ones are not re-run, preserving server-side row idempotence.

   **Decomp policy:** decomp runs every cycle alongside safety + correctness, in parallel. The legacy orchestrator's "Final Stage — Decomposition Review" optimization (run decomp only at plan end) is retired in this design. Per-cycle decomp catches DRY violations and trivial-repetition slop early, before they propagate across cycles. The token cost is accepted as the price of nipping decomposition rot in the bud.
3. Reviewer sessions are launched with **scoped permissions**, not `--dangerously-skip-permissions`:
   ```
   claude --allowed-tools "Read,Grep,Glob,Bash(git diff:*,git log:*,wc:*,ls:*)" \
          -p "$REVIEWER_PROMPT" \
          --append-system-prompt "$(cat .compiled-agents/container-<role>-reviewer-ue.md)" \
          --output-format json
   ```
   No `Edit`, no `Write`, no broad `Bash`. Reviewer cannot modify source code at all. Output goes to stdout, captured by the parent shell into the per-role file.
4. Each reviewer's prompt instructs: *"Your last action before exiting is to POST your verdict and findings to `${SERVER_URL}/tasks/<task-id>/reviews` with the structured payload below. Then exit."* The agent skill already produces a markdown report; amend the output schema to *also* emit a JSON block with structured `findings[]` matching the API shape from Phase 3. Reviewer parses its own markdown into the JSON before posting (yes, it's redundant; the markdown is the source of truth and the JSON is a structured shadow for Supabase queries).
5. **Severity-tier collapse in `skills/review-output-schema/SKILL.md`.** This skill is composed into every reviewer agent (front matter `skills:` list); the BLOCKING/WARNING/NOTE template, the confidence rubric, and the orchestrator-blocking sentence all live in this single file. Editing only the per-reviewer agent definitions would not take effect — the compiler would re-inject the WARNING tier from the skill at compile time. Apply the changes here:
   - **Template (currently lines ~12-38):** Remove the `## WARNING` section entirely. Keep `## BLOCKING` and add a `## NOTE` section (which the existing template only mentions parenthetically under "Rules"). Renumber finding IDs as `B1, B2, …, N1, N2, …` and drop the W-prefixed IDs.
   - **Confidence-threshold rule:** Replace the implicit three-tier scheme baked into the template confidence ranges (90-100 BLOCK / 75-89 WARN / 50-74 NOTE) with a two-tier rule. Suggested language: *"BLOCK any finding you're at least 75% confident about and that requires action this cycle. NOTE any finding below 75% confidence OR any finding that does not require action but is worth aggregating across tasks. Do not report findings below 50% confidence."*
   - **Orchestrator-blocking boilerplate (currently line 46):** Remove *"All WARNINGs are treated as blocking by the orchestrator. Only report issues you are confident about and can substantiate with specific code evidence. Do not pad with borderline nitpicks."* Replace with *"NOTE entries are observability-only and never block a cycle. BLOCKING entries always block. Do not pad either tier with borderline calls; if you cannot substantiate the finding with specific code evidence, omit it."*
   - **Verdict rule (currently line 44):** Change *"Verdict is REQUEST CHANGES if any BLOCKING or WARNING exists"* to *"Verdict is REQUEST CHANGES if any BLOCKING exists; APPROVE otherwise. NOTEs do not affect the verdict."*
   - **NOTE-tier line (currently line 45):** The current text reads *"Some domains add a NOTE tier (confidence 50-74, informational only). If present, NOTEs do not affect the verdict."* Replace with *"NOTE is a first-class tier alongside BLOCKING; every reviewer may emit NOTEs and they never affect the verdict."*
   - The Spec-Fidelity Finding Resolution section (currently lines 48-62) is unchanged.

   Per-reviewer agent definitions in `dynamic-agents/container-{safety,correctness,decomposition}-reviewer-ue.md` only need a sweep for any reviewer-specific text that mentions WARNINGs (e.g. category lists, examples). Most of the tier semantics flows from the skill above.
6. **Reviewers are blind to each other.** No reviewer sees the cycle's consolidated file or another reviewer's per-role file. Each reviewer reads only the spec (plan path) and the changed source files. This preserves the parallel-and-blind property argued in the design conversation; sequential review with cross-reading was rejected for priming reasons.
7. After `wait` returns, the container's reviewer-fanout script:
   - Reads each `<role>.md` and constructs `consolidated.md` by literal concatenation with section headers (`## [<ROLE> REVIEW]`). No LLM in this step.
   - Writes `.scratch/reviews/<task-id>/cycle-<N>/consolidated.md`.
   - Examines the `verdict` from each reviewer (read from the JSON payload each reviewer wrote alongside its markdown). If all `approve` or `out_of_scope`: `POST /tasks/:id/transition {to: 'complete'}`. If any `request_changes`: `POST /tasks/:id/transition {to: 'revising', payload: {latestReviewPath: '.scratch/reviews/<task-id>/cycle-<N>/consolidated.md'}}`.
8. **Reviewer set is project-default with per-task override.** The fanout iterates `effectiveAgentRoles.reviewers` (Phase 4 step 2a). For piste-perfect's default config, that's safety + correctness + decomp every cycle. The fanout has no opinion about which reviewers should run; it dispatches whoever is declared. **Override semantics are wholesale, not per-key:** an `agentRolesOverride.reviewers` value replaces the entire reviewers map. To run a subset of the default roles for one task, the override must restate the keepers. Example: a refactor task whose explicit goal is consolidating duplicates would set `agentRolesOverride.reviewers = {"safety": "container-safety-reviewer-ue", "correctness": "container-reviewer-ue"}` (omitting decomp, since decomp's BLOCKINGs would fight the work). A task that runs zero reviewers is currently invalid — the Phase 1 schema requires `reviewers` to have at least one entry.

**Acceptance criteria:**
- All declared reviewer subprocesses run concurrently (verifiable via `ps` or container logs showing overlapping start/end timestamps). For piste-perfect default config: three subprocesses (safety, correctness, decomp) every cycle.
- Each reviewer's stdout lands in its own per-role file. No interleaving.
- A reviewer that crashes mid-session leaves a `.tmp` file and never POSTs to `/reviews`. The fanout's recovery check detects the missing run for that `(taskId, cycle, reviewerRole)` triple and re-launches the single missing reviewer up to two times. If still missing after retries, the task transitions to `failed` with `failureReason: 'reviewer_infrastructure_failure'` and `failureDetail: '<role> reviewer did not produce a verdict after 2 retries (cycle <N>)'` — the *task* fails, not the reviewer's verdict (which was never rendered).
- **Recovery skip:** if `reviewer-fanout.sh` is invoked for a `(task, cycle)` where two of three reviewers have already posted runs, only the third reviewer is launched. Verifiable: kill the container after one reviewer has POSTed; restart; observe that the startup probe re-enters the `reviewing` state and the fanout dispatches only the two missing roles.
- `consolidated.md` is byte-identical to the alphabetically-ordered concatenation of the per-role files with `## [<ROLE> REVIEW]` section headers prepended.
- Three sequential `POST /tasks/:id/reviews` calls (one per reviewer) succeed and produce three rows in `review_runs` with shared `(taskId, cycle)`.
- A reviewer attempting `Write` or `Edit` on any source file fails with a tool-not-allowed error (proven by deliberately authoring a reviewer prompt that requests a file edit and observing the rejection).
- A task with `agentRolesOverride.reviewers = {"correctness": "container-reviewer-ue"}` runs only the correctness reviewer; safety and decomp are not dispatched.
