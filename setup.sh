#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Parse flags ──────────────────────────────────────────────────────────────
NON_INTERACTIVE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --non-interactive)
      NON_INTERACTIVE=true; shift ;;
    --help)
      echo "Usage: ./setup.sh [--non-interactive]"
      echo ""
      echo "First-time setup for ue-claude-scaffold."
      echo "Checks prerequisites, creates config files, and installs dependencies."
      exit 0 ;;
    *)
      echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

echo "=== ue-claude-scaffold setup ==="
echo ""

# ── Check prerequisites ─────────────────────────────────────────────────────
_missing=false

check_tool() {
  local name="$1"
  local cmd="$2"
  if version=$($cmd 2>&1); then
    echo "  [OK]      $name — $version"
  else
    echo "  [MISSING] $name"
    _missing=true
  fi
}

echo "Checking prerequisites..."
check_tool "Git" "git --version"

if docker compose version &>/dev/null; then
  echo "  [OK]      Docker Compose — $(docker compose version 2>&1)"
elif docker-compose --version &>/dev/null; then
  echo "  [OK]      Docker Compose — $(docker-compose --version 2>&1)"
else
  echo "  [MISSING] Docker Compose (neither 'docker compose' nor 'docker-compose' found)"
  _missing=true
fi

check_tool "jq" "jq --version"
check_tool "Node.js" "node --version"

echo ""

if [[ "$_missing" == true ]]; then
  echo "One or more prerequisites are missing. Install them and re-run setup." >&2
  exit 1
fi

# ── .env setup ───────────────────────────────────────────────────────────────
if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
  cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
  echo "Created .env from .env.example."
  echo "  -> Edit .env with your authentication credentials."
else
  echo ".env already exists — skipping."
fi

# ── scaffold.config.json setup ──────────────────────────────────────────────
if [[ ! -f "$SCRIPT_DIR/scaffold.config.json" ]]; then
  cp "$SCRIPT_DIR/scaffold.config.example.json" "$SCRIPT_DIR/scaffold.config.json"
  echo "Created scaffold.config.json from scaffold.config.example.json."
  echo "  -> Edit scaffold.config.json with your project paths and details before launching."
else
  echo "scaffold.config.json already exists — skipping."
fi

# ── docker-compose.yml setup ────────────────────────────────────────────────
if [[ ! -f "$SCRIPT_DIR/container/docker-compose.yml" ]]; then
  cp "$SCRIPT_DIR/container/docker-compose.example.yml" "$SCRIPT_DIR/container/docker-compose.yml"
  echo "Created container/docker-compose.yml from docker-compose.example.yml."
  echo "  -> Add any local plugin volume mounts to container/docker-compose.yml."
else
  echo "container/docker-compose.yml already exists — skipping."
fi

echo ""

# ── Bare repo initialization ────────────────────────────────────────────────

# Helper: clone a bare repo and create docker/{project-id}/current-root branch.
# Usage: _create_bare_and_root <bare_repo_path> <project_path> <project_id> [<label>]
# Returns 0 always; errors are printed to stderr (caller continues under set -e).
_create_bare_and_root() {
  local bare="$1"
  local proj="$2"
  local pid="$3"
  local label="${4:-}"

  if ! git clone --bare "$proj" "$bare"; then
    echo "  Error: Failed to create bare repo at $bare${label:+ ($label)}" >&2
    return 0  # return 0 to continue processing remaining projects under set -e
  fi
  local head
  if ! head=$(git -C "$bare" rev-parse HEAD 2>/dev/null); then
    if ! head=$(git -C "$proj" rev-parse HEAD 2>/dev/null); then
      echo "  Warning: could not resolve HEAD in bare or project repo — skipping update-ref${label:+ ($label)}."
      return 0
    fi
  fi
  if ! git -C "$bare" update-ref "refs/heads/docker/${pid}/current-root" "$head"; then
    echo "  Error: Failed to create docker/${pid}/current-root in $bare${label:+ ($label)}" >&2
    return 0
  fi
  echo "  Created docker/${pid}/current-root branch in bare repo."
}

# Helper: create or verify a bare repo for a given project path and bare repo path.
# Usage: _init_bare_repo <bare_repo_path> <project_path> <project_id> [<label>]
_init_bare_repo() {
  local bare="$1"
  local proj="$2"
  local pid="$3"
  local label="${4:-}"

  if [[ -z "$bare" || -z "$proj" ]]; then
    return
  fi

  if [[ ! -d "$proj" ]]; then
    echo "  Warning: project path does not exist: $proj — skipping${label:+ ($label)}."
    return
  fi

  if [[ ! -d "$bare" ]]; then
    if [[ "$NON_INTERACTIVE" == true ]]; then
      echo "Creating bare repo at $bare${label:+ ($label)} ..."
      _create_bare_and_root "$bare" "$proj" "$pid" "${label:-}"
    else
      read -rp "Create bare repo at $bare${label:+ ($label)} from $proj? [y/N] " _answer
      if [[ "${_answer,,}" == "y" ]]; then
        _create_bare_and_root "$bare" "$proj" "$pid" "${label:-}"
      else
        echo "  Skipped bare repo creation. You can create it later or launch.sh will create it."
      fi
    fi
  else
    echo "Bare repo already exists at $bare${label:+ ($label)}."

    # Migration: detect old-style docker/current-root and copy to docker/{pid}/current-root
    if git -C "$bare" rev-parse --verify refs/heads/docker/current-root &>/dev/null; then
      if ! git -C "$bare" rev-parse --verify "refs/heads/docker/${pid}/current-root" &>/dev/null; then
        local old_sha
        old_sha=$(git -C "$bare" rev-parse refs/heads/docker/current-root)
        git -C "$bare" update-ref "refs/heads/docker/${pid}/current-root" "$old_sha"
        echo "  Migrated: copied docker/current-root to docker/${pid}/current-root (old branch preserved for in-flight containers)."
      fi
    fi

    if ! git -C "$bare" rev-parse --verify "refs/heads/docker/${pid}/current-root" &>/dev/null; then
      echo "  Warning: docker/${pid}/current-root branch missing. Create it:"
      echo "    git -C $bare branch docker/${pid}/current-root HEAD"
    fi
  fi
}

_config="$SCRIPT_DIR/scaffold.config.json"

if [[ -f "$_config" ]] && jq -e '.projects' "$_config" &>/dev/null; then
  # Multi-project mode: iterate each project key, reading fields individually
  # to avoid TSV serialization issues with newlines in JSON values.
  echo "Multi-project config detected. Checking bare repos..."
  while IFS= read -r _key; do
    _bare="$(jq -r --arg k "$_key" '.projects[$k].bareRepoPath // empty' "$_config")"
    _proj="$(jq -r --arg k "$_key" '.projects[$k].path // empty' "$_config")"
    _init_bare_repo "$_bare" "$_proj" "$_key" "$_key"
    echo ""
  done < <(jq -r '.projects | keys[]' "$_config")
else
  # Single-project mode (legacy): read from top-level fields
  _bare=""
  _proj=""
  if [[ -f "$_config" ]]; then
    _bare="$(jq -r '.server.bareRepoPath // empty' "$_config")"
    _proj="$(jq -r '.project.path // empty' "$_config")"
  fi
  _init_bare_repo "${_bare:-}" "${_proj:-}" "default"
fi

echo ""

# ── Server dependencies ─────────────────────────────────────────────────────
if [[ ! -d "$SCRIPT_DIR/server/node_modules" ]]; then
  echo "Installing server dependencies..."
  cd "$SCRIPT_DIR/server" && npm install
  cd "$SCRIPT_DIR"
  echo "Server dependencies installed."
else
  echo "Server dependencies already installed — skipping."
fi

echo ""

# ── Agent definitions ────────────────────────────────────────────────────────
if [[ "$NON_INTERACTIVE" == true ]]; then
  echo "Skipping agent definition install (non-interactive mode)."
  echo "  To install manually: cp agents/*.md ~/.claude/agents/"
else
  read -rp "Copy agent definitions to ~/.claude/agents/? [y/N] " _answer
  if [[ "${_answer,,}" == "y" ]]; then
    mkdir -p ~/.claude/agents
    cp "$SCRIPT_DIR"/agents/*.md ~/.claude/agents/
    echo "Agent definitions copied."
  else
    echo "Skipped. You can install later: cp agents/*.md ~/.claude/agents/"
  fi
fi

echo ""

# ── Docker image pre-build ──────────────────────────────────────────────────
if [[ "$NON_INTERACTIVE" == true ]]; then
  echo "Skipping Docker image pre-build (non-interactive mode)."
  echo "  To build manually: cd container && docker compose build"
else
  read -rp "Pre-build Docker image now? [y/N] " _answer
  if [[ "${_answer,,}" == "y" ]]; then
    echo "Building Docker image..."
    cd "$SCRIPT_DIR/container"
    if docker compose build 2>/dev/null; then
      echo "Docker image built."
    elif docker-compose build 2>/dev/null; then
      echo "Docker image built."
    else
      echo "Warning: Docker build failed. You can retry later." >&2
    fi
    cd "$SCRIPT_DIR"
  else
    echo "Skipped. The image will be built on first launch."
  fi
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit .env with your authentication credentials"
echo "  2. Edit scaffold.config.json with your project paths"
echo "  3. Start the coordination server:  cd server && npm run dev"
echo "  4. Launch an agent:                ./launch.sh"
echo "  5. Monitor progress:               ./status.sh --follow"
