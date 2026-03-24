# Remote Workflow Endpoints — Implementation Spec

## Context

The PistePerfect coordination server (Fastify + TypeScript, port 9100, SQLite/better-sqlite3) needs three new endpoints to support remote workflow orchestration. The project owner will be away and working via Claude Code CLI on a remote system, pushing planning commits to GitHub. These endpoints let the home system pull those changes, launch agent containers, and push results back.

### Current Local Workflow
1. Interactive planning session (read Engine/Project source, iterate on design)
2. Formalise multi-phase plan in `Notes/` folder
3. Commit the plan
4. `POST /tasks` — server merges latest interactive repo commits into the bare repo
5. Manually launch Docker containers

### Target Remote Workflow
1. Plan + commit remotely via Claude Code CLI → push to GitHub
2. `POST /sync/github/pull` — home server pulls from GitHub into bare repo
3. `POST /tasks` — post task definitions (existing endpoint)
4. `POST /containers/start` — launch agent containers
5. Agents work autonomously (existing flow)
6. `POST /sync/github/push` — push agent results back to GitHub for remote review

---

## Endpoint 1: `POST /sync/github/pull`

Pull latest commits from the GitHub remote into the local working repo, then merge into the bare repo's `docker/current-root` branch (mirroring what `POST /sync/plans` does, but sourcing from GitHub).

### Request

```typescript
interface GithubPullRequest {
  branch?: string;           // GitHub branch to pull (default: "main")
  targetAgents?: string[];   // Optional: propagate to these agent branches after merge
}
```

### Response

```typescript
// 200 OK
interface GithubPullResponse {
  success: true;
  branch: string;
  previousHead: string;      // commit SHA before pull
  newHead: string;            // commit SHA after pull
  commitsPulled: number;
  propagatedTo: string[];    // agent branches updated (if targetAgents was set)
  output: string;
}

// 409 Conflict
interface GithubPullConflict {
  success: false;
  error: "merge_conflict";
  branch: string;
  conflictFiles: string[];
  stderr: string;
}

// 500 Internal Server Error
interface GithubPullError {
  success: false;
  error: string;
  stderr: string;
}
```

### HTTP Status Codes
- `200` — pull and merge succeeded
- `409` — merge conflict (requires manual resolution)
- `500` — git command failed or server error

### Implementation Notes

1. **Reuse `POST /sync/plans` logic.** That endpoint already merges committed state into `docker/current-root`. Factor out the merge-into-bare-repo step into a shared helper, then:
   - `/sync/plans` calls: read from local interactive repo → shared merge helper
   - `/sync/github/pull` calls: `git fetch origin` + `git merge origin/{branch}` on the local repo → same shared merge helper

2. **Git operations sequence:**
   ```
   cd <local-working-repo>
   git fetch origin
   git checkout {branch}
   git merge origin/{branch} --ff-only   # or --no-ff depending on preference
   # Then use the same bare-repo merge as /sync/plans:
   # merge local repo HEAD into bare-repo docker/current-root
   ```

3. **If `targetAgents` is provided**, call the same logic as `POST /agents/{name}/sync` for each agent to propagate `docker/current-root` into `docker/{name}`.

4. **Mutex:** Acquire the same git-operation lock used by `/sync/plans` to prevent concurrent merges.

5. **Ensure GitHub remote is configured.** If `git remote get-url origin` fails, return a descriptive error. Consider a config field in the server config for the remote name (default: `origin`).

---

## Endpoint 2: `POST /containers/start`

Launch one or more Claude Code Docker containers, each connected to its own branch in the bare repo.

### Request

```typescript
interface ContainersStartRequest {
  agents?: string[];          // Specific agent names, e.g. ["agent-1", "agent-2"]
  count?: number;             // Alternative: launch N agents with auto-generated names
  syncBeforeStart?: boolean;  // Default true: sync docker/current-root → docker/{name} before launch
}
// Provide either `agents` or `count`, not both. Default: count=2
```

### Response

```typescript
// 200 OK
interface ContainersStartResponse {
  success: true;
  agents: Array<{
    name: string;
    containerId: string;
    branch: string;           // e.g. "docker/agent-1"
    status: "started" | "already_running";
  }>;
}

// 409 Conflict (e.g. all requested agents already running)
interface ContainersStartConflict {
  success: false;
  error: "agents_already_running";
  runningAgents: string[];
}

// 500 Internal Server Error
interface ContainersStartError {
  success: false;
  error: string;
  stderr: string;
}
```

### HTTP Status Codes
- `200` — containers launched (some may report `already_running`)
- `409` — all requested agents are already running
- `500` — Docker command failed or server error

### Implementation Notes

1. **Container launch sequence per agent:**
   ```
   1. Check if container for {name} is already running (docker ps --filter)
   2. If syncBeforeStart: merge docker/current-root → docker/{name} in the bare repo
   3. docker run -d --name {name} <image> <args>
   4. POST /agents/register with { name, status: "active" }
   5. Return containerId from docker run output
   ```

2. **Use the existing agent lifecycle.** Call the same registration logic as `POST /agents/register` internally. This keeps the agent list consistent with what `GET /agents` returns.

3. **Container image and arguments** should come from server config (e.g., `config.docker.image`, `config.docker.runArgs`). The existing container launch scripts likely have these — extract them into config.

4. **Branch setup:** If `docker/{name}` doesn't exist in the bare repo, create it from `docker/current-root` before launching.

5. **Partial success:** If launching 2 agents and one fails, return 200 with the successful one marked `started` and include an `errors` array for failures. Don't roll back the successful launch.

6. **Cleanup consideration:** Consider adding `POST /containers/stop` as a companion (could be a fast follow-up). For now, the existing `DELETE /agents/{name}` can handle deregistration, and the caller can `docker stop` via a separate mechanism if needed.

---

## Endpoint 3: `POST /sync/github/push`

Push the latest bare repo state (typically the merged agent work) back to GitHub.

### Request

```typescript
interface GithubPushRequest {
  branch?: string;            // Branch to push (default: "main")
  sourceBranch?: string;      // Bare repo branch to push from (default: "docker/current-root")
  force?: boolean;            // Force push (default: false)
}
```

### Response

```typescript
// 200 OK
interface GithubPushResponse {
  success: true;
  branch: string;
  sourceBranch: string;
  commitsPushed: number;
  remoteHead: string;         // new HEAD SHA on remote
  output: string;
}

// 409 Conflict
interface GithubPushConflict {
  success: false;
  error: "push_rejected";
  branch: string;
  hint: string;               // e.g. "Remote has commits not in local. Pull first, or use force:true"
  stderr: string;
}

// 500 Internal Server Error
interface GithubPushError {
  success: false;
  error: string;
  stderr: string;
}
```

### HTTP Status Codes
- `200` — push succeeded
- `409` — push rejected (remote has diverged)
- `500` — git command failed or server error

### Implementation Notes

1. **Git operations sequence:**
   ```
   # First, update the local working repo from the bare repo
   cd <local-working-repo>
   git fetch <bare-repo-path> {sourceBranch}:{branch}
   git push origin {branch}
   ```
   Alternatively, push directly from the bare repo if it has the GitHub remote configured:
   ```
   cd <bare-repo-path>
   git push origin {sourceBranch}:{branch}
   ```

2. **Coalesce before pushing.** Consider requiring or recommending that `/coalesce/*` has been run before pushing — this ensures all agent work is merged into `docker/current-root` and there are no in-flight tasks.

3. **The `force` option** exists for cases where the remote has diverged and the caller explicitly wants to overwrite. Default to `false` and return a 409 with a helpful hint if the push is rejected.

4. **Mutex:** Same git-operation lock as the pull endpoint.

5. **Branch mapping:** The most common use case will be pushing `docker/current-root` → `main` (or whatever the GitHub default branch is). But supporting arbitrary branch names lets the caller push to a `results/session-N` branch if they want to keep main clean.

---

## Shared Implementation Concerns

### Git Helper Utility

Factor git operations into a shared module (e.g., `src/utils/git.ts`):

```typescript
interface GitExecResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function gitExec(cwd: string, args: string[]): Promise<GitExecResult>;
async function getCommitCount(cwd: string, from: string, to: string): Promise<number>;
async function getCurrentHead(cwd: string, branch?: string): Promise<string>;
```

### Git Operation Mutex

All three endpoints (plus existing `/sync/plans`) should share a single mutex to prevent concurrent git operations on the same repos. The UBT lock pattern already exists — consider a similar lightweight lock for git ops, or reuse the same approach with a different lock name.

### Route Organisation

Suggest grouping under a `src/routes/github.ts` plugin:

```typescript
// src/routes/github.ts
export default async function githubRoutes(server: FastifyInstance) {
  server.post('/sync/github/pull', pullHandler);
  server.post('/sync/github/push', pushHandler);
}

// src/routes/containers.ts
export default async function containerRoutes(server: FastifyInstance) {
  server.post('/containers/start', startHandler);
}
```

### Configuration

Add to server config:

```typescript
interface ServerConfig {
  // ... existing fields ...
  github: {
    remote: string;           // default: "origin"
    defaultBranch: string;    // default: "main"
  };
  docker: {
    image: string;            // container image name
    runArgs: string[];        // additional docker run arguments
    maxAgents: number;        // maximum concurrent agents (default: 4)
  };
}
```

### Schema Validation

Use Fastify's built-in JSON Schema validation for request bodies:

```typescript
const pullSchema = {
  body: {
    type: 'object',
    properties: {
      branch: { type: 'string', default: 'main' },
      targetAgents: { type: 'array', items: { type: 'string' } }
    }
  }
};
```

---

## End-to-End Remote Workflow Sequence

```
Remote (Claude Code CLI)              GitHub                Home Server (port 9100)
─────────────────────────             ──────                ───────────────────────
1. Plan + edit in repo
2. git commit + git push ──────────→  main updated
3. POST /sync/github/pull ─────────────────────────────────→ fetch + merge into
                                                             docker/current-root
4. POST /tasks (with task defs) ───────────────────────────→ tasks queued
5. POST /containers/start ─────────────────────────────────→ launch agent-1, agent-2
                                                             agents work autonomously...
6. GET /tasks (poll for completion) ───────────────────────→ check status
7. GET /messages (read agent logs) ────────────────────────→ review progress
8. POST /sync/github/push ────────────────────────────────→ push docker/current-root
                                                    ──────→  results branch updated
9. git pull ←──────────────────────  fetch results
10. Review agent work locally
```
