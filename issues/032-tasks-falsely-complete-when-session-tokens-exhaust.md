# Issue: False Completion Of Tasks

## Failure Scenario 1

1. The Claude account supplying the OAuth token for container environments hits a per-session token cap
2. The server/containers enters a failure state due to Claude being unable to consume further tokens.
3. In Progress tasks are marked as complete, and Pending tasks are claimed then completed in rapid succession, without
   any work being done.
4. The entire queue of tasks flips to "Completed", regardless of how much outstanding work may exist, and how much may
   have been done.

## Failure Scenario 2

```bash
Starting Claude Code (agent: container-orchestrator)...

Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"},"request_id":"req_011CZSJuSjPBc11AjPhbpdSP"}


```

Authentication failure causes the same false-positive cascade.

## Correct Behaviour

1. Per-session (window/API) token cap is reached, or authentication failure occurs.
2. Claude cannot do further work.
3. Container is gracefully shutdown:
    1. Uncommitted work is discarded (presumed invalid)
    2. A log is recorded with the server that the agent previously shut down due to token exhaustion
4. Container can be manually restarted in the next session window
    1. Agent's branch is preserved at the state of the last intentional commit
    2. The start up prompt informs the Agent they're resuming a session that was prematurely suspended
    3. All existing protocol about file-claiming and task dependencies remain in place:
        1. Agents cannot jump lanes to work on a task sequence started on a different branch
        2. Agents cannot begin tasks that require files locked to another agent's branch.

## Underlying Principle

Token exhaustion or authentication failure is an intermittent but inevitable failure mode of the system. The existing
infrastructure is already carefully framed to support graceful failure and recovery: persistent, valid data is not corrupted; invalid or ephemeral
data is not wastefully persisted. The scaffold infrastructure must allow for credential and mothership API access failures as one of the _expected_
failure modes.

---

## Resolution

**Status: Addressed** (2026-03-26)

### Measures Taken

1. **Abnormal exit detection** (`container/entrypoint.sh`): After Claude exits, output is scanned for auth failure
   patterns (`authentication_error`, `Failed to authenticate`), token/rate limit patterns (`token.*limit`,
   `quota.*exceeded`, etc.), and a rapid-exit heuristic (<10s runtime with <5 lines output). Detection triggers
   regardless of exit code — catches the exit-0-on-auth-failure case from Scenario 2.

2. **Protective response on abnormal exit**: Uncommitted work is discarded (`git checkout`/`clean`), the claimed task
   is released back to `pending` (not marked complete or failed), an `abnormal_shutdown` message is posted to the
   `general` channel with the reason, and agent status is set to `error`. Branch is preserved at the last intentional
   commit.

3. **Circuit breaker in pump loop**: Consecutive abnormal exits are tracked. After 2 in a row, the pump stops entirely
   with a clear message. Prevents the cascade where every task in the queue gets falsely completed or failed.

4. **Full container logging**: All terminal output (`exec > >(tee ...)`) is mirrored to a host-mounted `logs/`
   directory as `{agent}-{timestamp}.log`. Logs survive container shutdown for forensic review. Enabled by default
   via a `/logs` volume mount in `docker-compose.example.yml`, with `launch.sh` creating the directory and exporting
   `LOGS_PATH`.

5. **Chat agent coverage**: The same abnormal exit detection applies to design team agents (`run_chat_agent`).

### Files Changed

- `container/entrypoint.sh` — core detection, circuit breaker, logging
- `launch.sh` — `LOGS_PATH` setup and export
- `container/docker-compose.example.yml` — `/logs` volume mount
- `.gitignore` — `logs/` directory

