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

echo ""

# ── Bare repo initialization ────────────────────────────────────────────────
# Read paths from scaffold.config.json
_bare=""
_clone_source=""
if [[ -f "$SCRIPT_DIR/scaffold.config.json" ]]; then
    _bare="$(jq -r '.server.bareRepoPath // empty' "$SCRIPT_DIR/scaffold.config.json")"
    _proj="$(jq -r '.project.path // empty' "$SCRIPT_DIR/scaffold.config.json")"
    _staging="$(jq -r '.server.stagingWorktreePath // empty' "$SCRIPT_DIR/scaffold.config.json")"
    _clone_source="${_staging:-${_proj}}"
fi

if [[ -n "$_bare" && -n "$_clone_source" && ! -d "$_bare" && -d "$_clone_source" ]]; then
  if [[ "$NON_INTERACTIVE" == true ]]; then
    echo "Creating bare repo at $_bare ..."
    git clone --bare "$_clone_source" "$_bare"
    echo "Bare repo created."
  else
    read -rp "Create bare repo at $_bare from $_clone_source? [y/N] " _answer
    if [[ "${_answer,,}" == "y" ]]; then
      git clone --bare "$_clone_source" "$_bare"
      echo "Bare repo created."
    else
      echo "Skipped bare repo creation. You can create it later or launch.sh will create it."
    fi
  fi
elif [[ -n "$_bare" && -d "$_bare" ]]; then
  echo "Bare repo already exists at $_bare — skipping."
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
echo "  4. Launch an agent:                ./launch.sh --plan path/to/plan.md"
echo "  5. Monitor progress:               ./status.sh --follow"
