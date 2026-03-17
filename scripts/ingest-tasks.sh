#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Usage ────────────────────────────────────────────────────────────────────
usage() {
  cat <<'USAGE'
Usage: ./scripts/ingest-tasks.sh [OPTIONS]

Scan a directory of markdown task files and post them to the coordination
server's task queue. Each .md file becomes one task.

Frontmatter (between --- delimiters) supports these keys:
  title:               Task title (required)
  priority:            Integer priority, higher = first (default: 0)
  acceptance_criteria: Single-line acceptance criteria

Everything after the closing --- becomes the task description.
Complex multi-line acceptance criteria should go in the description body.

Options:
  --tasks-dir PATH    Directory containing task .md files (default: ./tasks)
  --server-url URL    Coordination server URL (default: http://localhost:9100)
  --dry-run           Print what would be posted without sending
  --help              Show this help message

Examples:
  ./scripts/ingest-tasks.sh --tasks-dir plans/tasks
  ./scripts/ingest-tasks.sh --dry-run
  ./scripts/ingest-tasks.sh --server-url http://localhost:9200
USAGE
}

# ── Parse flags ──────────────────────────────────────────────────────────────
TASKS_DIR="./tasks"
DRY_RUN=false

# Source .env for SERVER_PORT if available
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

SERVER_URL="http://localhost:${SERVER_PORT:-9100}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tasks-dir)
      TASKS_DIR="$2"; shift 2 ;;
    --server-url)
      SERVER_URL="$2"; shift 2 ;;
    --dry-run)
      DRY_RUN=true; shift ;;
    --help)
      usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1 ;;
  esac
done

# ── Check dependencies ──────────────────────────────────────────────────────
if ! command -v curl &>/dev/null; then
  echo "Error: curl is required but not found." >&2
  exit 1
fi
if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not found." >&2
  exit 1
fi

# ── Validate tasks directory ────────────────────────────────────────────────
if [[ ! -d "$TASKS_DIR" ]]; then
  echo "Error: Tasks directory not found: $TASKS_DIR" >&2
  exit 1
fi

# ── State file for tracking ingested tasks ──────────────────────────────────
STATE_FILE="$TASKS_DIR/.ingest-state.json"
if [[ ! -f "$STATE_FILE" ]]; then
  echo "{}" > "$STATE_FILE"
fi

# ── Parse frontmatter from a markdown file ──────────────────────────────────
# Outputs: FM_TITLE, FM_PRIORITY, FM_AC, BODY
parse_frontmatter() {
  local file="$1"
  FM_TITLE=""
  FM_PRIORITY="0"
  FM_AC=""
  BODY=""

  local in_frontmatter=false
  local frontmatter_closed=false
  local line_num=0

  while IFS= read -r line || [[ -n "$line" ]]; do
    line_num=$((line_num + 1))

    if [[ $line_num -eq 1 && "$line" == "---" ]]; then
      in_frontmatter=true
      continue
    fi

    if [[ "$in_frontmatter" == true ]]; then
      if [[ "$line" == "---" ]]; then
        in_frontmatter=false
        frontmatter_closed=true
        continue
      fi

      # Parse simple key: value pairs
      local key value
      key=$(echo "$line" | sed -n 's/^\([a-zA-Z_]*\):.*/\1/p')
      value=$(echo "$line" | sed -n 's/^[a-zA-Z_]*:[[:space:]]*//p')

      case "$key" in
        title)               FM_TITLE="$value" ;;
        priority)            FM_PRIORITY="$value" ;;
        acceptance_criteria) FM_AC="$value" ;;
      esac
    else
      if [[ "$frontmatter_closed" == true ]]; then
        BODY="${BODY}${line}
"
      else
        # No frontmatter — entire file is the body
        BODY="${BODY}${line}
"
      fi
    fi
  done < "$file"

  # Trim leading/trailing whitespace from body
  BODY=$(echo "$BODY" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
}

# ── Ingest tasks ────────────────────────────────────────────────────────────
ingested=0
skipped=0

for file in "$TASKS_DIR"/*.md; do
  [[ -f "$file" ]] || continue

  filepath=$(cd "$(dirname "$file")" && pwd)/$(basename "$file")

  # Check if already ingested
  existing_id=$(jq -r --arg p "$filepath" '.[$p] // empty' "$STATE_FILE")
  if [[ -n "$existing_id" ]]; then
    skipped=$((skipped + 1))
    continue
  fi

  parse_frontmatter "$file"

  # Validate priority is an integer
  if ! [[ "${FM_PRIORITY:-0}" =~ ^-?[0-9]+$ ]]; then
    echo "Warning: Invalid priority '${FM_PRIORITY}' in $file, defaulting to 0" >&2
    FM_PRIORITY=0
  fi

  # Use filename as title fallback
  if [[ -z "$FM_TITLE" ]]; then
    FM_TITLE=$(basename "$file" .md | tr '-_' ' ')
  fi

  # Use body as description
  description="$BODY"

  if [[ "$DRY_RUN" == true ]]; then
    echo "[DRY RUN] Would post task:"
    echo "  File:     $filepath"
    echo "  Title:    $FM_TITLE"
    echo "  Priority: $FM_PRIORITY"
    echo "  AC:       ${FM_AC:-<none>}"
    echo "  Body:     $(echo "$description" | head -3)..."
    echo ""
    ingested=$((ingested + 1))
    continue
  fi

  # Build JSON payload
  json_payload=$(jq -n \
    --arg title "$FM_TITLE" \
    --arg description "$description" \
    --arg sourcePath "$filepath" \
    --arg acceptanceCriteria "$FM_AC" \
    --argjson priority "${FM_PRIORITY:-0}" \
    '{title: $title, description: $description, sourcePath: $sourcePath, acceptanceCriteria: (if $acceptanceCriteria == "" then null else $acceptanceCriteria end), priority: $priority}')

  response=$(curl -sf -X POST "${SERVER_URL}/tasks" \
    -H "Content-Type: application/json" \
    -d "$json_payload" \
    --max-time 10 2>/dev/null) || {
    echo "Error: Failed to post task from $filepath" >&2
    continue
  }

  task_id=$(echo "$response" | jq -r '.id')
  echo "Ingested: $FM_TITLE (ID: $task_id, priority: $FM_PRIORITY)"

  # Update state file
  jq --arg p "$filepath" --argjson id "$task_id" '. + {($p): $id}' "$STATE_FILE" > "${STATE_FILE}.tmp"
  mv "${STATE_FILE}.tmp" "$STATE_FILE"

  ingested=$((ingested + 1))
done

echo ""
if [[ "$DRY_RUN" == true ]]; then
  echo "Dry run complete. $ingested task(s) would be ingested, $skipped skipped (already ingested)."
else
  echo "Done. $ingested task(s) ingested, $skipped skipped (already ingested)."
fi
