# Agent-fetch pipeline hardening

## Goal

Make the live-container path for "claim a task with `agentTypeOverride` and download the required agent definitions" robust under crashes, source updates, transitive references, and transport errors. Eliminate the cache-staleness, partial-write, silent-skip, and useless-diagnostic failure modes documented in the audit on 2026-04-27.

## Context

The audit traced the current pipeline end-to-end and confirmed today's transport fix (`container/lib/agent-fetch.sh:66` had `--` swallowing the wrapper's `-H` flags). With that fixed, the path functions, but eight defects remain. The biggest practical risks are partial-write corruption (a kill between writing the lead and the last sub-agent leaves a "looks-cached" but broken state) and silent stale sub-agents ("leaving in place" never actually checks freshness). Both are solved by replacing the lead-existence cache predicate with a sidecar manifest that is written last and contains a hash plus a list of required sibling files.

The plan also exposes a server-side hash-only endpoint so that long-lived pump containers can validate freshness on every cache hit without paying for a full bundle compile, and tightens error classification so the operator can tell a missing-name (4xx) from a server bug (5xx) from a transport failure (HTTP 000) without reading container stderr.

Out of scope: any change to who claims tasks, the launch script's bare-repo or branch handling, or the `.claude/CLAUDE.md` agent-type-discovery flow. Static `agents/*.md` definitions stay supported alongside dynamic ones.

Operator note: every phase that touches `container/`, `container/lib/`, or `Dockerfile` requires a container image rebuild and a smoke launch before that phase counts as verified — orchestrators inside containers cannot recurse Docker.

<!-- PHASE-BOUNDARY -->

## Phase 1 — Server: emit a bundle manifest and a hash-only endpoint

**Outcome:** `GET /agents/definitions/:type` returns `sourceHash` and `requiredAgents` alongside the existing fields. A new `GET /agents/definitions/:type/hash` returns `{sourceHash}` without serializing sub-agents. The CLI `node server/dist/bin/compile-agent.js --recursive` writes a `${type}.bundle.json` sidecar next to each compiled lead.

**Types / APIs:**

```ts
// server/src/agent-compiler.ts — new exported types
export interface BundleManifest {
  type: string;                  // lead agent type (filename stem)
  sourceHash: string;            // sha256 hex of the lead's compiled body bytes
  requiredAgents: string[];      // filename stems of every dynamic sub-agent referenced
  bundleErrors: string[];        // fatal dispatchability problems (currently: two-level nesting)
  warnings: string[];            // non-fatal advisories
  fetchedAt: string;             // RFC3339 UTC; producer-stamped
}

// server/src/agent-compiler.ts — extend existing result
export interface CompileWithSubAgentsResult {
  main: CompiledAgent;
  subAgents: CompiledAgent[];
  warnings: string[];
  bundleErrors: string[];        // NEW — promoted from warnings when transitive references are detected
  manifest: BundleManifest;      // NEW
}

// server/src/routes/agent-definitions.ts — extend GET response shape
type GetAgentDefinitionResponse = {
  agentType: string;
  markdown: string;
  meta: { "access-scope": string };
  subAgents: Array<{ agentType: string; markdown: string; meta: { "access-scope": string } }>;
  warnings: string[];
  bundleErrors: string[];        // NEW
  manifest: BundleManifest;      // NEW — same shape the CLI writes to disk
};

// server/src/routes/agent-definitions.ts — new endpoint
// GET /agents/definitions/:type/hash → 200 { sourceHash: string } | 404
type GetAgentHashResponse = { sourceHash: string };
```

**Work:**

- Add `computeBundleManifest(source, dynamicDir, exclude)` to `server/src/agent-compiler.ts`. It compiles the lead in-memory (no disk write), runs `findSubAgents` against the compiled body, hashes the compiled body with `crypto.createHash("sha256").update(body).digest("hex")`, and returns a `BundleManifest`. It also classifies any second-level reference returned by recursing `findSubAgents` over each sub-agent's compiled body as a `bundleErrors` entry rather than a `warnings` entry.
- Extend `compileAgentWithSubAgents` to populate `bundleErrors` and `manifest` on its result. The existing two-level-nesting message stays in both `warnings` (back-compat) and `bundleErrors` (new); callers should prefer `bundleErrors`.
- In `server/src/bin/compile-agent.ts`, after each `--recursive` invocation, write `${output}/${stem}.bundle.json` containing the `BundleManifest` from the result. Include a stable JSON serialization (`JSON.stringify(manifest, null, 2) + "\n"`).
- In `server/src/routes/agent-definitions.ts`, register a second route `GET /agents/definitions/:type/hash`. Implementation: re-use the source-locating block from the existing handler, compile the lead body in-memory via `compileAgent` into a fresh `mkdtemp` (or refactor a `compileLeadBodyOnly` helper that skips disk writes — preferred), hash it, return `{sourceHash}`. 404 if neither source path exists.
- Extend the existing GET handler to attach the manifest produced by `compileAgentWithSubAgents` to the response. For the static-agent branch, build the manifest by hashing the static markdown directly and computing `requiredAgents` from `findSubAgents`. `bundleErrors` for the static branch follows the same transitive-reference rule.

**Verification:**

- `cd server; npm run typecheck`
- `cd server; npx tsx --test src/agent-compiler.test.ts src/routes/agent-definitions.test.ts`
- New tests:
  - `agent-compiler.test.ts` — `computeBundleManifest` returns identical `sourceHash` for two calls on the same source, populates `requiredAgents` exactly with the matched sub-agent names, and promotes a transitive reference from `warnings` into `bundleErrors`.
  - `agent-definitions.test.ts` — `GET /agents/definitions/:type` includes `manifest` and `bundleErrors`; `GET /agents/definitions/:type/hash` returns only `{sourceHash}` and matches the `manifest.sourceHash` from the full GET; both endpoints 404 for an unknown type.
- Manual: `node server/dist/bin/compile-agent.js dynamic-agents/content-catalogue-dashboard-orchestrator.md -o /tmp/cc-out --skills-dir skills --dynamic-dir dynamic-agents --recursive` produces `/tmp/cc-out/content-catalogue-dashboard-orchestrator.bundle.json` whose `requiredAgents` lists the five `scaffold-dashboard-*` sub-agents.

<!-- PHASE-BOUNDARY -->

## Phase 2 — Container: manifest-based cache with atomic write

**Outcome:** `_ensure_agent_type` uses the presence of `${AGENTS_DIR}/${type}.bundle.json` as the cache predicate, not `${AGENTS_DIR}/${type}.md`. A fetch writes every lead and sub-agent file first, then renames the bundle manifest into place last. A kill between any of those writes leaves no `.bundle.json`, so the next attempt re-fetches the entire bundle. Sub-agents listed in the manifest are overwritten on fetch — never "left in place."

**Types / APIs:**

```bash
# container/lib/agent-fetch.sh — cache-hit predicate becomes:
#   [ -f "${AGENTS_DIR}/${agent_type}.bundle.json" ] && _bundle_complete "$agent_type"
#
# _bundle_complete returns 0 when every name in the manifest's
# requiredAgents has a corresponding ${name}.md in AGENTS_DIR.

_bundle_complete() {
  local agent_type="$1"
  local manifest="${AGENTS_DIR}/${agent_type}.bundle.json"
  [ -f "$manifest" ] || return 1
  local missing
  missing=$(jq -r '.requiredAgents[]' "$manifest" \
    | while read -r name; do [ -f "${AGENTS_DIR}/${name}.md" ] || echo "$name"; done)
  [ -z "$missing" ]
}
```

**Work:**

- In `container/lib/agent-fetch.sh`, replace the `[ -f "$lead_file" ]` early-return in `_ensure_agent_type` with a call to `_bundle_complete`. Add `_bundle_complete` as a private helper.
- Stage the entire bundle into a temp directory before publishing. Use `mktemp -d -p "$AGENTS_DIR" .stage-XXXXXX` so the staging dir is on the same filesystem (rename is atomic). Write `${stage}/${type}.md`, `${stage}/${type}.meta.json`, and one pair per sub-agent into the staging dir.
- After all files are staged, write the manifest from the response into `${stage}/${type}.bundle.json`. Then `mv "${stage}"/* "$AGENTS_DIR/"` and `mv "${stage}/${type}.bundle.json" "${AGENTS_DIR}/${type}.bundle.json"` last (separate move so the manifest publication is the very last filesystem op).
- Remove the "leaving in place" branch for sub-agents — fetched bundles overwrite. The manifest is the source of truth for what a bundle contains.
- Update `container/lib/workspace-setup.sh` `_snapshot_agents` to copy `*.bundle.json` alongside the `*.md` and `*.meta.json` files (the `cp /staged-agents/*` already does this; verify and add an explicit assertion that `${AGENT_TYPE}.bundle.json` exists when `/staged-agents` is non-empty).
- Trap failures: if any write step fails, `rm -rf "$stage"` and return 1 from `_ensure_agent_type`. Never leave a partial staging dir behind.

**Verification:**

- `bash -n container/lib/agent-fetch.sh container/lib/workspace-setup.sh`
- Add a shellcheck pass on both files (`shellcheck container/lib/agent-fetch.sh container/lib/workspace-setup.sh`) — no new warnings.
- Operator smoke test:
  - `cd server; npm run build` (Phase 1's CLI changes need to be installed).
  - `./launch.sh --project piste-perfect --fresh --dry-run` to confirm AGENTS_PATH points at a fresh `.compiled-agents/` containing `${AGENT_TYPE}.bundle.json`.
  - Rebuild the image: `docker compose -f container/docker-compose.yml build --no-cache claude-worker`.
  - Launch a real container, observe logs include `Cached agent definition '<type>'` and `${AGENT_TYPE}.bundle.json` is present in the container at `/home/claude/.claude/agents/`.
  - Kill the container mid-fetch (e.g. `docker kill` after a task is claimed but before Claude is launched). Restart. Observe the second run re-fetches (no spurious cache hit).

<!-- PHASE-BOUNDARY -->

## Phase 3 — Container: source-hash freshness check on every cache hit

**Outcome:** When `_bundle_complete` returns 0, the container also issues `GET /agents/definitions/${type}/hash` and compares the returned `sourceHash` against the locally cached manifest's `sourceHash`. A mismatch falls through to the normal full-bundle fetch path, overwriting the cached files. Hash check failures (network, non-200) do not invalidate the cache — they only log and continue with the cached bundle.

**Types / APIs:**

```bash
# container/lib/agent-fetch.sh
_cache_is_fresh() {
  local agent_type="$1"
  local manifest="${AGENTS_DIR}/${agent_type}.bundle.json"
  local local_hash remote_hash response http_status
  local_hash=$(jq -r '.sourceHash // empty' "$manifest")
  [ -n "$local_hash" ] || return 0  # legacy manifest with no hash → trust it

  response=$(_curl_server -s -w "\n%{http_code}" --max-time 5 \
    "${SERVER_URL}/agents/definitions/${agent_type}/hash") || response=$'\n000'
  http_status="${response##*$'\n'}"
  if [ "$http_status" != "200" ]; then
    echo "WARNING: hash check for '${agent_type}' failed (HTTP ${http_status}); using cached copy" >&2
    return 0
  fi
  remote_hash=$(printf '%s' "${response%$'\n'*}" | jq -r '.sourceHash // empty')
  [ "$local_hash" = "$remote_hash" ]
}
```

**Work:**

- Add `_cache_is_fresh` to `container/lib/agent-fetch.sh`.
- In `_ensure_agent_type`, the cache-hit branch becomes: `if _bundle_complete "$agent_type" && _cache_is_fresh "$agent_type"; then echo "Agent definition '${agent_type}' already cached and fresh."; return 0; fi`. On a stale-hash detection, log `Hash mismatch for '${agent_type}' — refetching.` and fall through.

**Worked example.** Operator edits `dynamic-agents/content-catalogue-dashboard-orchestrator.md` while a pump container is running and a second task with the override arrives.

- Local manifest `sourceHash`: `abc123…` (matches the version compiled into `.compiled-agents/` at launch).
- Server `GET .../hash` after edit: `def456…`.
- `_cache_is_fresh` returns 1 (mismatch); fetch proceeds; bundle is overwritten; manifest is rewritten with `sourceHash = def456…`.
- Next claim of the same override hits the cache and `_cache_is_fresh` confirms identity.

**Verification:**

- `bash -n container/lib/agent-fetch.sh`
- Operator smoke test:
  - With a container running and a task pending that uses an override, edit the corresponding `dynamic-agents/*.md` (e.g. add a trailing newline to bump the hash).
  - Submit the task. Observe the container log shows `Hash mismatch for '<type>' — refetching.` and the bundle's `sourceHash` in `${AGENTS_DIR}/<type>.bundle.json` updates to the new value.
  - Stop the coordination server. Observe the next cache-check logs `WARNING: hash check for '<type>' failed (HTTP 000); using cached copy` and the task proceeds with the existing bundle.

<!-- PHASE-BOUNDARY -->

## Phase 4 — Container: error classification and bundleErrors enforcement

**Outcome:** Task failure records distinguish four causes — `agent-type-not-found` (HTTP 404), `agent-type-server-error` (HTTP 5xx), `agent-type-network-error` (HTTP 000 / curl failure), and `agent-type-bundle-invalid` (response body has non-empty `bundleErrors[]`). Bundle errors abort the fetch before any file is written; the staging dir is removed.

**Types / APIs:**

```bash
# container/lib/pump-loop.sh — failure payload becomes structured:
fail_payload=$(jq -n \
  --arg code "$err_code" \
  --arg type "$CURRENT_TASK_AGENT_TYPE" \
  --arg detail "$err_detail" \
  '{"error": ("agent-type-fetch-failed:" + $type), "code": $code, "detail": $detail}')

# err_code is one of:
#   agent-type-not-found
#   agent-type-server-error
#   agent-type-network-error
#   agent-type-bundle-invalid
# err_detail is a short human string (truncated server body excerpt or curl exit code).
```

**Work:**

- In `container/lib/agent-fetch.sh` `_ensure_agent_type`, after the curl returns:
  - If `http_status == "000"` → set `_FETCH_ERR_CODE=agent-type-network-error` and `_FETCH_ERR_DETAIL` to a short message including the captured curl stderr (Phase 5 adds capture).
  - If `http_status == "404"` → `_FETCH_ERR_CODE=agent-type-not-found`, detail is the body excerpt.
  - If `http_status` is `5xx` → `_FETCH_ERR_CODE=agent-type-server-error`, detail is the body excerpt.
  - Otherwise (`4xx` non-404) → reuse `agent-type-server-error` with detail "HTTP ${http_status}".
- After parsing the response body, before staging any files: if `(.bundleErrors // []) | length > 0`, set `_FETCH_ERR_CODE=agent-type-bundle-invalid` and `_FETCH_ERR_DETAIL` to the joined `bundleErrors` array, log to stderr, return 1 without writing anything.
- In `container/lib/pump-loop.sh`, replace the existing single-string error payload at the fail-task POST site with the structured shape above, reading `_FETCH_ERR_CODE` and `_FETCH_ERR_DETAIL`. Default `code=agent-type-network-error` and `detail="unspecified"` if either is unset.
- The legacy `error: "agent-type-fetch-failed:<type>"` string is preserved for grep-based dashboards; the `code` and `detail` fields are additive.

**Verification:**

- `cd server; npx tsx --test src/routes/tasks-lifecycle.test.ts` — the `/tasks/:id/fail` route accepts arbitrary JSON bodies; verify the new shape persists end-to-end.
- Operator smoke test, four scenarios:
  - Missing type: ingest a task with `agentTypeOverride: "does-not-exist"`. Failed task `result.code` is `agent-type-not-found`.
  - Bundle invalid: temporarily edit a `dynamic-agents/*.md` so it references a sub-agent that itself references a third agent (forces transitive nesting). Ingest a task referencing the lead. Failed task `result.code` is `agent-type-bundle-invalid`. Revert the edit.
  - Server error: stop the coordination server only after the container has claimed a task but before fetch (race-y; alternatively introduce a temporary 500-throwing handler under a feature flag). Failed task `result.code` is `agent-type-network-error` or `agent-type-server-error` depending on which arm fired.
  - Healthy fetch: ingest a normal task with a known override. Task succeeds.

<!-- PHASE-BOUNDARY -->

## Phase 5 — Container: diagnostics and ergonomics

**Outcome:** Container `_is_safe_name` enforces the same 1–64 character cap that `server/src/branch-naming.ts:13`'s `AGENT_NAME_RE` enforces, so no over-length name silently produces an `agent-type-server-error`. Curl stderr is captured to a temp file for the duration of every `_curl_server` call and surfaced on HTTP 000. The `subAgents[]` walk in `_ensure_agent_type` parses the response body once (single `jq -c` stream) instead of N×3 invocations per sub-agent.

**Types / APIs:**

```bash
# container/lib/env.sh — replace the existing _is_safe_name body:
_is_safe_name() {
  [[ "$1" =~ ^[a-zA-Z0-9_-]{1,64}$ ]]
}

# container/lib/registration.sh — _curl_server gains stderr capture:
_curl_server() {
  local stderr_log="${_CURL_STDERR_LOG:-/tmp/curl.err}"
  curl "$@" -H "X-Agent-Name: ${AGENT_NAME}" -H "X-Project-Id: ${PROJECT_ID}" 2>"$stderr_log"
  local rc=$?
  if [ "$rc" -ne 0 ] && [ -s "$stderr_log" ]; then
    _LAST_CURL_STDERR="$(head -c 500 "$stderr_log")"
  else
    _LAST_CURL_STDERR=""
  fi
  return "$rc"
}
```

**Work:**

- Update `container/lib/env.sh` `_is_safe_name` to enforce the 1–64 length bound. Confirm every existing call site (`AGENT_NAME`, `PROJECT_ID`, `agent_type`, `sub_type`, `effective_agent_type`) still passes for legitimate values.
- Update `container/lib/registration.sh` `_curl_server` to redirect stderr to a per-call temp file and store a 500-byte excerpt in `_LAST_CURL_STDERR` on non-zero exit. Reset `_LAST_CURL_STDERR` to empty on success.
- In `container/lib/agent-fetch.sh`, when the HTTP-000 branch runs, append `_LAST_CURL_STDERR` to the stderr log and to `_FETCH_ERR_DETAIL` (Phase 4 reads this).
- Refactor the sub-agent loop in `_ensure_agent_type` to parse once: write `$body` to `${stage}/response.json`, then iterate via `jq -r '.subAgents | length'` once, and use a single `jq -r ".subAgents[$i] | [.agentType, (.markdown // empty), (.meta[\"access-scope\"] // \"read-only\")] | @tsv"` per index, splitting on tab in shell. Same approach for the `warnings[]` walk. Goal: at most one `jq` call per index instead of three.

**Verification:**

- `bash -n container/lib/env.sh container/lib/registration.sh container/lib/agent-fetch.sh`
- `shellcheck container/lib/env.sh container/lib/registration.sh container/lib/agent-fetch.sh`
- Operator smoke test:
  - Set `CURRENT_TASK_AGENT_TYPE` to a 70-character string (mock test only — do not ingest a real task with this name); confirm the container rejects locally without HTTP traffic.
  - Stop the coordination server, claim a task with an override, observe the failed-task `result.detail` includes a curl error string like `Could not resolve host: host.docker.internal` instead of an empty diagnostic.
  - Compare wall-clock time of `_ensure_agent_type` against a 5-sub-agent bundle before and after (rough timing via `time` around a manual call). Expect a measurable reduction (target ≥40% faster on the parsing portion).
