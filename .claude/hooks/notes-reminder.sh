#!/usr/bin/env bash
# Stop hook: nudge to run /take-notes when a submodule's notes are missing or stale.
#
# Fires quietly (exit 0, no output) unless there is something worth saying, so it
# does not nag on every turn. Reads hook JSON on stdin but does not need it.
#
# Staleness heuristics:
#   1. A submodule folder exists with no notes.md, AND the repo has source files
#      newer than the notes/ tree  -> we have likely built past the notes.
#   2. Any notes.md is older than the newest source file under src/  -> code moved on.

set -uo pipefail
cat >/dev/null 2>&1 || true   # drain stdin

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
[ -d notes ] || exit 0

# Newest source file (if any source exists yet).
newest_src=$(find src tests test 2>/dev/null -type f \
  \( -name '*.ts' -o -name '*.js' -o -name '*.sql' -o -name '*.prisma' \) \
  -newer notes -print -quit 2>/dev/null)

# Submodule dirs that have no notes.md yet.
missing=$(find notes -mindepth 2 -maxdepth 2 -type d \
  '!' -exec test -e '{}/notes.md' ';' -print 2>/dev/null | sort)

# Only speak up when code exists that is newer than the notes tree.
[ -n "$newest_src" ] || exit 0
[ -n "$missing" ] || exit 0

count=$(printf '%s\n' "$missing" | wc -l | tr -d ' ')
first=$(printf '%s\n' "$missing" | head -3 | sed 's|^notes/|  - |')
[ "$count" -gt 3 ] && first="$first
  ...and $((count - 3)) more"

msg="Notes may be behind the code — ${count} submodule(s) have no notes.md yet:
${first}

Run /take-notes to write them."

# Build JSON with jq so newlines and any punctuation are escaped correctly.
jq -n --arg m "$msg" '{systemMessage: $m}'
exit 0
