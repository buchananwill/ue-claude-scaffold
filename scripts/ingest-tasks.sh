#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib/curl-json.sh
source "$SCRIPT_DIR/lib/curl-json.sh"

# ── Defaults ────────────────────────────────────────────────────────────────
TASKS_DIR="./tasks"
DRY_RUN=false

_cfg_port=9100
if [[ -f "$SCRIPT_DIR/../scaffold.config.json" ]]; then
  _cfg_port="$(jq -r '.server.port // 9100' "$SCRIPT_DIR/../scaffold.config.json" 2>/dev/null || echo 9100)"
fi
SERVER_URL="http://localhost:$_cfg_port"

# ── Parse flags ─────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tasks-dir)  TASKS_DIR="$2"; shift 2 ;;
    --server-url) SERVER_URL="$2"; shift 2 ;;
    --project)    export PROJECT_ID="$2"; shift 2 ;;
    --dry-run)    DRY_RUN=true; shift ;;
    --help)
      echo "Usage: $0 [--tasks-dir PATH] [--server-url URL] [--project ID] [--dry-run] [--help]"
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "${PROJECT_ID:-}" ]]; then
  echo "Warning: --project not specified; targeting project 'default'" >&2
fi

# ── Validate ────────────────────────────────────────────────────────────────
if [[ ! -d "$TASKS_DIR" ]]; then
  echo "Error: Tasks directory not found: $TASKS_DIR" >&2
  exit 1
fi

TASKS_DIR="$(cd "$TASKS_DIR" && pwd)"

if [[ "$DRY_RUN" == true ]]; then
  echo "[DRY RUN] Would ingest .md files from: $TASKS_DIR"
  for f in "$TASKS_DIR"/*.md; do
    [[ -f "$f" ]] && echo "  $(basename "$f")"
  done
  exit 0
fi

# ── Ingest via server ──────────────────────────────────────────────────────
response="$(_post_json "${SERVER_URL}/tasks/ingest" "$(jq -n --arg tasksDir "$TASKS_DIR" '{"tasksDir": $tasksDir}')")" || {
  echo "Error: POST /tasks/ingest failed" >&2
  exit 1
}

ingested="$(echo "$response" | jq -r '.ingested')"
skipped="$(echo "$response" | jq -r '.skipped')"
replanned="$(echo "$response" | jq -r '.replanned')"
errors="$(echo "$response" | jq -r '.errors')"

echo "Done. ${ingested} task(s) ingested, ${skipped} skipped, ${replanned} replanned, ${errors} error(s)."

if [[ "$errors" -gt 0 ]]; then
  exit 1
fi
