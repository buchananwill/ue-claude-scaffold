-- 0009_rename_complete_to_completed.sql
--
-- Rename the terminal task status 'complete' to 'completed' so it agrees with
-- the past-participle convention already used by the other terminal/transient
-- statuses ('claimed','built','failed','integrated'). 'complete' was the
-- single grammatical outlier (an adjective rather than a past participle) and
-- caused a real bug: several pre-FSM dep-satisfaction queries still tested
-- for the prior literal 'completed', so no row ever satisfied a downstream
-- dep until an operator manually integrated it.
--
-- Forward steps:
--   1. Drop the existing tasks_status_check (it forbids the new value).
--   2. Rewrite every existing 'complete' row to 'completed' so the new CHECK
--      will admit the data we are about to gate.
--   3. Add the new tasks_status_check that admits 'completed' and forbids
--      'complete'. The full status list is reproduced verbatim (no other
--      change versus 0007) so this migration is a pure rename.
--
-- The pre-FSM archive table (`tasks_pre_fsm_archive`) is untouched — its
-- CHECK was renamed in 0007 to `tasks_pre_fsm_archive_status_check` and its
-- frozen rows must keep their original values.
--
-- The sessions table's `ccs_status_check` (which also uses 'complete') is
-- intentionally left alone in this migration. Its status set is independent
-- of task status and the rename there is a separate decision.

ALTER TABLE "tasks" DROP CONSTRAINT "tasks_status_check";

UPDATE "tasks" SET "status" = 'completed' WHERE "status" = 'complete';

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_check" CHECK ("status" IN (
  'pending','claimed','engineering','built','reviewing',
  'revising','arbitrating','completed','failed','integrated','cycle'
));
