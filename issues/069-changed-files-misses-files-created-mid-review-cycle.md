---
title: "CHANGED_FILES omits files created mid-review-cycle, so a late file can carry the bulk of a revision and dodge per-file review"
priority: medium
reported-by: interactive-session
date: 2026-08-16
---

# CHANGED_FILES misses files created mid-review-cycle

During task 223 (piste-perfect), `RegionFixtureCapture.h/.cpp` and its spec were created in a revision
cycle and never appeared in any reviewer's CHANGED_FILES round — the safety reviewer itself flagged at
the end that it had never been shown the file. The host-side arrival inspection caught it (the files
were read in full at merge and were clean), but the container-side review cycle is supposed to be the
first net, and a file created after the first cycle's roster is invisible to it.

Suggested fixes:
1. Recompute CHANGED_FILES per cycle from the branch's cumulative diff against its seed, not from the
   cycle's incremental delta.
2. Add a reviewer checklist line: diff the full branch file list against the union of all CHANGED_FILES
   rounds and name any file never reviewed.
