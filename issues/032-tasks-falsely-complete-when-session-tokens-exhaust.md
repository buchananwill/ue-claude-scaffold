# Issue: False Completion Of Tasks

## Failure Scenario

1. The Claude account supplying the OAuth token for container environments hits a per-session token cap
2. The server/containers enters a failure state due to Claude being unable to consume further tokens.
3. In Progress tasks are marked as complete, and Pending tasks are claimed then completed in rapid succession, without
   any work being done.
4. The entire queue of tasks flips to "Completed", regardless of how much outstanding work may exist, and how much may
   have been done.

## Correct Behaviour

1. Per-session (window/API) token cap is reached.
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

Token exhaustion is an intermittent but inevitable failure mode of the system. The existing infrastructure is already
carefully framed to support graceful failure and recovery: persistent, valid data is not corrupted; invalid or ephemeral
data is not wastefully persisted. The scaffold infrastructure must allow for token exhaustion as one of the _expected_
failure modes. 

