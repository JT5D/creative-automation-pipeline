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

step "Prose punctuation is ASCII"
# The docs are read in four places that do not agree about typography: a
# terminal, a GitHub diff, a rendered page and a printed PDF. Typographic dashes
# and smart quotes survive some of those and not others, and a doc set that
# mixes both looks careless in the one that mangles them. So the prose is ASCII,
# and this is the check rather than a style note nobody rereads.
#
# -I skips binaries, whose bytes hit these sequences by coincidence.
# The bundled font licence is third-party text and must not be edited.
if git ls-files -z | xargs -0 grep -lI -e $'\xe2\x80\x94' -e $'\xe2\x80\x93' \
     -e $'\xe2\x80\x9c' -e $'\xe2\x80\x9d' -e $'\xe2\x80\x99' 2>/dev/null \
   | grep -v '^assets/fonts/LICENSE.md$' | grep -q .; then
  fail "a tracked file uses typographic dashes or smart quotes; write them as ASCII"
fi

step "No stray build output tracked"
# Named directories plus anything that looks generated. Listing offenders by
# name alone misses the next one, which is how .baseline-run/ once shipped.
if git ls-files | grep -qE '^(outputs/|node_modules/|dist/|\.cache/|\.baseline-run/)'; then
  fail "build output or dependencies are tracked"
fi
# A run artifact is only a problem where it was produced. docs/sample-output/
# holds one on purpose, so a reviewer can see a real result without cloning.
if git ls-files | grep -vE '^docs/sample-output/' | grep -qE '(^|/)(report\.json|runs\.jsonl)$'; then
  fail "a generated run artifact is tracked outside docs/sample-output/"
fi

printf '\n  All checks passed.\n\n'
