#!/usr/bin/env bash
# Release gate. Everything that must be true before this ships.
#   npm run check
set -euo pipefail

fail() { printf '\n  ✗ %s\n\n' "$1" >&2; exit 1; }
step() { printf '\n▸ %s\n' "$1"; }

step "Types";      npx tsc --noEmit
step "Lint";       npx biome check src tests scripts
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
if git ls-files | grep -qE '(^|/)(report\.json|runs\.jsonl)$'; then
  fail "a generated run artifact is tracked"
fi

step "Sample briefs match their advertised results"
npx vitest run -t "advertises" >/dev/null

printf '\n  All checks passed.\n\n'
