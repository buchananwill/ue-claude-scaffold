---
title: "Capture full agent session transcripts for prompt tuning"
priority: medium
reported-by: interactive-session
date: 2026-03-21
---

# Capture full agent session transcripts for prompt tuning

## Problem

When tuning agent definitions (orchestrator, implementer, reviewers), we have no way to see the
full session transcript — what the agent actually did, what tools it called, what reasoning it
produced, what it decided and why. The message board gives us a curated summary the agent chose
to post, but the real diagnostic value is in the raw session output.

`claude -p` writes the complete session to stdout: every tool call, every reasoning step, the
full verbatim transcript. Today that output goes to Docker's default log driver and is lost when
the container is removed. We need to capture it, persist it, and make it queryable.

## Motivation

This is specifically for prompt tuning and debugging review misses — not for regular operational
monitoring (the message board handles that). When a reviewer misses a style violation or an
implementer makes a bad architectural choice, we need to read the transcript to understand
whether the agent definition was unclear, the context was too large, or the model just dropped
something. Without transcripts, tuning agent definitions is guesswork.

The review split in issue #014 makes this more urgent — we now have 5 agent types whose
definitions need tuning, and each produces its own session transcript.

## Proposed design

### Container side (entrypoint.sh)

- Pipe the `claude -p` invocation through `tee` to capture stdout to a local file
  (e.g. `/tmp/transcript-${AGENT_NAME}.log`) while preserving normal stdout for Docker logs.
- On clean exit, POST the transcript file to the server's new `/transcripts` endpoint.
- Add a `trap` handler for crashes/signals that attempts to push whatever was captured before
  the process died. Best-effort — partial transcripts are still valuable.

### Server side

- New `transcripts` table in SQLite:
  - `id` INTEGER PRIMARY KEY
  - `agent_name` TEXT NOT NULL
  - `phase` TEXT (nullable — worker mode tasks don't have phases)
  - `content` TEXT NOT NULL (the full transcript — can be 100k+ characters)
  - `byte_size` INTEGER NOT NULL (for list queries without loading content)
  - `created_at` TEXT NOT NULL
- New route plugin `src/routes/transcripts.ts`:
  - `POST /transcripts` — accepts `{ agent_name, phase?, content }`, stores in DB.
    Agent identified by `X-Agent-Name` header as usual.
  - `GET /transcripts` — list transcripts with filtering by agent name, date range.
    Returns metadata only (id, agent_name, phase, byte_size, created_at) — never the content
    in list responses.
  - `GET /transcripts/:id` — returns full transcript content for a single record.
  - `DELETE /transcripts` — bulk delete (e.g. older than N days). Transcripts are large;
    need a cleanup path.
- Schema goes in `src/db.ts` alongside existing tables.
- The `content` column will be large. Queries that list or filter transcripts must never
  SELECT the content column — only the metadata fields.

### Dashboard side (future — not blocking)

- A transcripts page for browsing and searching. Not a priority — `curl` against the API
  is sufficient for the initial prompt-tuning workflow. Dashboard work can be planned
  separately once the server API is stable.

## Scope

- Modify `container/entrypoint.sh` to `tee` stdout and POST on exit
- Add `transcripts` table to `src/db.ts`
- Add `src/routes/transcripts.ts` with POST/GET/DELETE endpoints
- Add tests for the new routes
- Dashboard page is out of scope for the initial implementation

## Open questions

- Should we compress transcripts before storing? SQLite handles large TEXT fine, but disk
  usage could grow fast with multiple agents running daily. Could gzip the content and store
  as BLOB, but that makes grep-style searching harder.
- Should the entrypoint stream the transcript incrementally (chunked POST during the session)
  or only push on completion? Streaming would let us watch live, but adds complexity and the
  message board already covers live monitoring.
