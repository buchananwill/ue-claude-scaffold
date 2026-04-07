# Debrief 0074 -- Phase 9: Container-side workspace patching

## Task Summary

Replace `container/patch_workspace.py` with inline bash in `container/entrypoint.sh`, delete the Python file, and remove `python3` from the Dockerfile apt-install line and the `COPY patch_workspace.py` line.

## Changes Made

- **container/entrypoint.sh** -- Replaced the `python3 /patch_workspace.py` call (lines 193-195) with inline bash that replicates the same behavior: create `/workspace/Plugins`, iterate `/plugins-ro/*/`, symlink each plugin directory if not already present.
- **container/patch_workspace.py** -- Deleted.
- **container/Dockerfile** -- Removed `python3 \` from the apt-get install line. Removed `COPY patch_workspace.py /patch_workspace.py` line.

## Design Decisions

- The inline bash matches the Python behavior exactly: mkdir -p for Plugins, iterate subdirectories, symlink with `ln -sfn` if link does not already exist.
- Used `[ -d "$plugin_dir" ] || continue` guard to skip non-directory entries, matching the Python `if plugin_dir.is_dir()` check.

## Build & Test Results

- `bash -n container/entrypoint.sh` -- syntax valid.
- `cd server && npm run build` -- clean build, no errors.
- `cd server && npm test` -- pending (running in background).

## Open Questions / Risks

- `container/container-settings.json` still references `python3 /claude-hooks/lint-cpp-diff.py` (lines 26 and 35), but Phase 8 replaced that file with `lint-cpp-diff.mjs`. With python3 now removed from the Dockerfile, those hook commands will fail at runtime. This appears to be an incomplete update from Phase 8 that needs to be addressed separately.

## Suggested Follow-ups

- Update `container/container-settings.json` to reference `node /claude-hooks/lint-cpp-diff.mjs` instead of `python3 /claude-hooks/lint-cpp-diff.py`.
