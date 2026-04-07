#!/bin/bash
# scripts/lib/branch-setup.sh -- Agent branch management in the bare repo.
#
# Creates, resets, or resumes agent branches in the bare repo.
# Source this file; do not execute it directly.

# Guard against double-sourcing
[[ -n "${_LIB_BRANCH_SETUP_LOADED:-}" ]] && return 0
readonly _LIB_BRANCH_SETUP_LOADED=1

# _setup_branch <branch_name> <fresh_flag>
#   Ensures the branch exists in BARE_REPO_PATH, forking from ROOT_BRANCH
#   if needed or resetting if fresh=true.
_setup_branch() {
  local branch="$1"
  local fresh="$2"

  if [[ "$fresh" == "true" ]]; then
    local root_sha
    root_sha=$(git -C "$BARE_REPO_PATH" rev-parse "refs/heads/${ROOT_BRANCH}")
    git -C "$BARE_REPO_PATH" update-ref "refs/heads/${branch}" "$root_sha"
    echo "  Reset branch ${branch} to ${ROOT_BRANCH} (--fresh)"
  elif ! git -C "$BARE_REPO_PATH" rev-parse --verify "refs/heads/${branch}" &>/dev/null; then
    local root_sha
    root_sha=$(git -C "$BARE_REPO_PATH" rev-parse "refs/heads/${ROOT_BRANCH}")
    git -C "$BARE_REPO_PATH" update-ref "refs/heads/${branch}" "$root_sha"
    echo "  Created branch ${branch} from ${ROOT_BRANCH}"
  else
    echo "  Resuming existing branch ${branch}"
  fi
}

# _validate_bare_repo
#   Checks that BARE_REPO_PATH exists and ROOT_BRANCH is present.
_validate_bare_repo() {
  if [[ ! -d "$BARE_REPO_PATH" ]]; then
    echo "Error: Bare repo not found at $BARE_REPO_PATH" >&2
    echo "Run ./setup.sh to create it, or create it manually:" >&2
    echo "  git clone --bare <your-project> $BARE_REPO_PATH" >&2
    exit 1
  fi

  if ! git -C "$BARE_REPO_PATH" rev-parse --verify "refs/heads/${ROOT_BRANCH}" &>/dev/null; then
    echo "Error: Branch '${ROOT_BRANCH}' not found in bare repo." >&2
    echo "Push it from your project:" >&2
    echo "  git push $BARE_REPO_PATH HEAD:refs/heads/${ROOT_BRANCH}" >&2
    exit 1
  fi
}
