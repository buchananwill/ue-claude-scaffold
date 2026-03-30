---
name: shell-script-safety
description: Shellcheck-level bash safety patterns — quoting, error handling, variable hygiene, and injection prevention for shell scripts.
axis: domain
---

# Shell Script Safety

Bash scripting domain knowledge at shellcheck level.

## Error Handling

```bash
# Set strict mode at the top of every script (or document why not)
set -euo pipefail

# Trap for cleanup
cleanup() { rm -f "$tmpfile"; }
trap cleanup EXIT
```

- `set -e` exits on error, but does NOT catch errors in pipes (use `pipefail`) or subshells
- Check exit codes explicitly where `set -e` is insufficient:

```bash
# WRONG — error swallowed in pipe
command_that_may_fail | grep pattern

# CORRECT — check explicitly
if ! output=$(command_that_may_fail); then
  echo "Failed" >&2
  exit 1
fi
echo "$output" | grep pattern
```

## Quoting

```bash
# ALWAYS quote variables
echo "$VAR"           # CORRECT
echo $VAR             # WRONG — word splitting, glob expansion

# Quote array expansion
for item in "${array[@]}"; do  # CORRECT
for item in ${array[@]}; do    # WRONG

# Quote command substitution
result="$(some_command)"       # CORRECT
result=$(some_command)         # Acceptable in assignment, but quote when used
```

## Conditionals

```bash
# Use [[ ]] over [ ]
[[ -f "$file" ]]      # CORRECT — no word splitting, supports pattern matching
[ -f "$file" ]         # Fragile — word splitting on unquoted vars

# String comparison
[[ "$var" == "value" ]]   # CORRECT
[[ "$var" = "value" ]]    # Also correct (POSIX)
```

## Variable Hygiene

```bash
# Use local in functions
my_function() {
  local result
  result="$(compute_something)"
  echo "$result"
}

# Use readonly for constants
readonly CONFIG_PATH="/etc/myapp/config"
readonly -a VALID_OPTIONS=("alpha" "beta" "gamma")

# Prefer $(command) over backticks
result="$(date +%s)"     # CORRECT — nestable, readable
result=`date +%s`        # WRONG — hard to nest, easy to misread
```

## Injection Prevention

```bash
# NEVER use unescaped user input in commands
# WRONG — shell injection
eval "process $user_input"
bash -c "echo $user_input"

# CORRECT — pass as arguments, not as code
process "$user_input"

# CORRECT — use arrays for complex commands
cmd=("process" "--flag" "$user_input")
"${cmd[@]}"
```

## Temp Files

```bash
# Use mktemp, never hardcoded paths
tmpfile="$(mktemp)"
tmpdir="$(mktemp -d)"

# Clean up in trap
trap 'rm -rf "$tmpdir"' EXIT
```

## Here-Documents

```bash
# Prevent expansion (literal content)
cat <<'EOF'
$NOT_EXPANDED
EOF

# Allow expansion (intentional)
cat <<EOF
Value is: $EXPANDED
EOF
```
