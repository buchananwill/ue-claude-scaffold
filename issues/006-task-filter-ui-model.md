---
title: "Task filter segmented control is the wrong UI model"
priority: low
reported-by: interactive-session
date: 2026-03-20
status: done
---

# Task filter segmented control is the wrong UI model

The task status filter in the dashboard uses a segmented control, which implies mutually exclusive
selection (one at a time). Task filtering should support any desired subset — e.g. show both
"pending" and "claimed" simultaneously.

## Proposed fix

Replace the segmented control with either:
- **Toggle pills** that highlight when activated (multiple can be active)
- **Multi-select dropdown**

When no filter is selected, show all tasks.
