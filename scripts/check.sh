#!/usr/bin/env bash
# Release gate. Everything that must be true before this ships.
#   npm run check
set -euo pipefail

fail() { printf '\n  ✗ %s\n\n' "$1" >&2; exit 1; }
step() { printf '\n▸ %s\n' "$1"; }

step "Types";      npx tsc --noEmit
step "Lint";       npx biome check src tests scripts
# One run, not two. This used to finish with a second `vitest run -t advertises`
# so the gate could print a line naming the sample-brief tests -- 29 seconds to
# re-run tests the line above had already run and already reported. The tests
# are named well enough to find in that output.
step "Tests";      npx vitest run
step "Build";      npx vite build >/dev/null

step "No secrets committed"
if git ls-files -z | xargs -0 grep -lE 'AIza[A-Za-z0-9_-]{30,}|sk-[A-Za-z0-9]{30,}|AQ\.[A-Za-z0-9_-]{40,}' 2>/dev/null | grep -q .; then
  fail "an API key pattern appears in a tracked file"
fi
git check-ignore -q .env || fail ".env is not gitignored"

step "No stray build output tracked"
# Named directories plus anything that looks generated. The first version of
# this listed offenders by name and missed .baseline-run/, which then shipped.
if git ls-files | grep -qE '^(outputs/|node_modules/|dist/|\.cache/|\.baseline-run/)'; then
  fail "build output or dependencies are tracked"
fi
# A run artifact is only a problem where it was produced. docs/sample-output/
# holds one on purpose, so a reviewer can see a real result without cloning.
if git ls-files | grep -vE '^docs/sample-output/' | grep -qE '(^|/)(report\.json|runs\.jsonl)$'; then
  fail "a generated run artifact is tracked outside docs/sample-output/"
fi

printf '\n  All checks passed.\n\n'
