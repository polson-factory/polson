#!/usr/bin/env bash
# Keeps a copy of one agent step's transcript (claude-code-action's execution file)
# for the workflow artifact the agent job uploads on failure or escalation.
#
# Usage: bash keep-transcript.sh <build|resolve1|resolve2> <execution-file>
# Writes $RUNNER_TEMP/transcripts/<name>.json. Every agent step writes the same
# execution file, so each step's copy is taken right after it. The workflow runs
# this only after the agent step ran, so a missing execution file is an anomaly:
# it is reported as a warning and noted in <name>.missing.txt for the artifact
# (AGENTS.md rule 6). It does not fail the step: the run's outcome comes from the
# agent and the scripts, not from this copy.
#
# Artifacts are not masked the way logs are, and a transcript can quote anything
# the agent read. So known credential formats are replaced with [REDACTED] before
# the copy is written: GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_),
# Anthropic keys (sk-ant-), JSON Web Tokens, x-access-token URLs and Authorization
# headers. If any match remains after redaction, nothing is kept.
set -euo pipefail

name="${1:-}"
src="${2:-}"
if ! [[ "$name" =~ ^(build|resolve1|resolve2)$ ]]; then
  echo "Usage: bash keep-transcript.sh <build|resolve1|resolve2> <execution-file>" >&2
  exit 2
fi
: "${RUNNER_TEMP:?RUNNER_TEMP must be set}"
dir="$RUNNER_TEMP/transcripts"
mkdir -p "$dir"
if [ -z "$src" ] || [ ! -f "$src" ]; then
  why="The $name step ran but left no transcript (execution file: '${src:-none}')."
  echo "::warning::$why"
  printf '%s\n' "$why" >"$dir/$name.missing.txt"
  exit 0
fi

secret_re='gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|x-access-token:[^@"'\''[:space:]]+|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]: *([Bb]asic|[Bb]earer|[Tt]oken) +[A-Za-z0-9+/=._-]+'

tmp=$(mktemp "$dir/.$name.XXXXXX")
trap 'rm -f "$tmp"' EXIT
sed -E "s#${secret_re}#[REDACTED]#g" "$src" >"$tmp"
if grep -E -q "$secret_re" "$tmp"; then
  echo "::warning::The $name transcript still matched a credential pattern after redaction; not keeping it."
  exit 0
fi
mv "$tmp" "$dir/$name.json"
echo "Kept the $name transcript ($(wc -c <"$dir/$name.json" | tr -d ' ') bytes, credentials redacted)."
