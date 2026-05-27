-- Drop the `tasks.latest_review_path` column.
--
-- This column was added in 0007 (fork_tasks_for_fsm) to hold a pointer to the
-- reviewer-fanout's `consolidated.md` so the engineer's revision session could
-- read it. It was always a persistent reference to an ephemeral object: that
-- file lives in a container's `.scratch/` workspace, which dies with the
-- container. The reference is therefore dangling for any resume on a different
-- container.
--
-- Under the findings-based review decision, reviews are the database of record
-- (review_runs + review_findings, populated by POST /tasks/:id/reviews). The
-- engineer's revision prompt now points at GET /tasks/:id/reviews/:cycle and
-- the concrete reviewRun IDs instead of a scratch file, so the column has no
-- remaining reader on either FSM edge (reviewing → revising no longer writes
-- it; the post-arbitration engineer branch reads DB review refs).

ALTER TABLE "tasks"
  DROP COLUMN "latest_review_path";
