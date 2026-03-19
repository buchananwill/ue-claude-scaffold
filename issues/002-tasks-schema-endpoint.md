---
title: "Add GET /tasks/schema for field discoverability"
priority: low
reported-by: interactive-session
date: 2026-03-19
---

# Add GET /tasks/schema for field discoverability

The recent QoL improvement (returning valid field names on unknown-field errors) is excellent. A proactive
complement would be a `GET /tasks/schema` endpoint that returns the accepted field names and types for
POST and PATCH, so callers can self-serve without needing to trigger an error first.
