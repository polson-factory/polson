#!/usr/bin/env bash
# Keeps a summary of one agent step's transcript for the workflow artifact the
# agent job uploads on failure or escalation.
#
# Usage: bash keep-transcript.sh <build|resolve1|resolve2> <execution-file>
# Writes $RUNNER_TEMP/transcripts/<name>.json, or <name>.missing.txt saying why
# there is none. The workflow runs this only after the agent step ran, so a missing
# transcript is an anomaly: it is reported as a warning and noted (AGENTS.md rule
# 6). It never fails the step: the run's outcome comes from the agent and the
# scripts, not from this copy.
#
# What is kept. This repository is public, so any signed-in GitHub user can
# download its artifacts. A transcript holds everything tools printed back (file
# contents, command output), and no denylist finds every secret in that. So only
# what the agent did is kept: its text, each tool call with its input, the text of
# failed or refused tool calls (cut to 300 characters), and the final result with
# its list of refused calls. Tool output, thinking and the prompt are dropped. Known
# credential formats are then replaced with [REDACTED]; if any match remains,
# nothing is kept.
#
# Where it comes from. claude-code-action writes its execution file (a JSON array
# of SDK messages) only when the session ends. A step cut off at its time limit
# leaves none, so the newest Claude Code session log (JSON lines, written as the
# session goes) is used instead and marked partial. Whichever is read, it and
# every session log are moved aside, so a later step can never pick up an earlier
# step's transcript.
set -euo pipefail

name="${1:-}"
src="${2:-}"
if ! [[ "$name" =~ ^(build|resolve1|resolve2)$ ]]; then
  echo "Usage: bash keep-transcript.sh <build|resolve1|resolve2> <execution-file>" >&2
  exit 2
fi
: "${RUNNER_TEMP:?RUNNER_TEMP must be set}"
dir="$RUNNER_TEMP/transcripts"
used="$RUNNER_TEMP/transcripts-used"
unswept="$used/.sessions-not-swept"
mkdir -p "$dir" "$used"
sessions="${CLAUDE_CONFIG_DIR:-${HOME:?HOME must be set}/.claude}/projects"

note() {
  printf '%s\n' "$1" >"$dir/$name.missing.txt"
  echo "::warning::$1"
  exit 0
}

# Pick the source: the action's execution file, else the newest session log.
format="" source=""
if [ -n "$src" ] && [ -f "$src" ]; then
  format=array
  source="execution_file"
else
  # An earlier step could not move every session log aside, so any log here may
  # be that step's, not this one's: keep none.
  if [ -e "$unswept" ]; then
    note "The $name step left no execution file, and an earlier step's Claude Code session logs could not all be moved aside, so no session log was kept as its transcript."
  fi
  src=""
  if [ -d "$sessions" ]; then
    while IFS= read -r -d '' log; do
      if [ -z "$src" ] || [ "$log" -nt "$src" ]; then src="$log"; fi
    done < <(find "$sessions" -name '*.jsonl' -type f -print0)
  fi
  [ -n "$src" ] || note "The $name step ran but left no transcript (no execution file, no Claude Code session log)."
  format=lines
  source="partial session log"
fi

filter='
  def text_of: if type == "string" then . elif type == "array" then (map(.text? // "") | join("\n")) else "" end;
  def cut($n): if length > $n then .[0:$n] + " [cut]" else . end;
  if type != "array" then error("not an array") else . end
  | {
    source: $source,
    steps: [ .[] |
      if .type == "assistant" then
        (.message.content // [])[]? |
          if .type == "text" then {say: .text}
          elif .type == "tool_use" then {call: .name, input: .input}
          else empty end
      elif .type == "user" and ((.message.content | type) == "array") then
        .message.content[] | select(.type == "tool_result" and .is_error == true) |
          {failed: (.content | text_of | cut(300))}
      else empty end ],
    result: ([ .[] | select(.type == "result") |
      {subtype, is_error, num_turns, text: ((.result // "") | tostring | cut(1000)),
       permission_denials: [ .permission_denials[]? | {tool_name, tool_input} ]} ] | last)
  }'

tmp=$(mktemp "$dir/.$name.XXXXXX")
trap 'rm -f "$tmp"' EXIT
read_ok=yes
if [ "$format" = array ]; then
  jq --arg source "$source" "$filter" "$src" >"$tmp" 2>/dev/null || read_ok=no # jq fails only on input it cannot read as the format above: unreadable, handled below.
else
  jq -s --arg source "$source" "$filter" "$src" >"$tmp" 2>/dev/null || read_ok=no # as above
fi

# Move what was read aside, so a later step never reuses it. Every session log
# goes too, whichever source was read: a step that leaves an execution file also
# leaves its session log, and a later step with no transcript of its own would
# otherwise read that log as its own (issue #36).
#
# The sweep must not fail the step (Qodo on PR #45): a directory find cannot read,
# a find error or a log still there afterwards is recorded in $unswept and warned
# about, and later steps then keep no session log (see the source pick above).
mv "$src" "$used/$name.$(basename "$src")"
swept=yes
if [ -d "$sessions" ]; then
  find "$sessions" -name '*.jsonl' -type f -exec mv {} "$used/" \; || swept=no
  if ! left=$(find "$sessions" -name '*.jsonl' -type f -print) || [ -n "$left" ]; then swept=no; fi
fi
if [ "$swept" = no ]; then
  : >"$unswept"
  echo "::warning::Not every Claude Code session log could be moved aside after the $name step, so later steps will not use a session log as their transcript."
fi

[ "$read_ok" = yes ] || note "The $name step's transcript could not be read, so none was kept."

secret_re='gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|x-access-token:[^@"'\''[:space:]]+|[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]: *([Bb]asic|[Bb]earer|[Tt]oken) +[A-Za-z0-9+/=._-]+'
redacted=$(mktemp "$dir/.$name.XXXXXX")
sed -E "s#${secret_re}#[REDACTED]#g" "$tmp" >"$redacted"
mv "$redacted" "$tmp"
if grep -E -q "$secret_re" "$tmp"; then
  note "The $name step's transcript still matched a credential pattern after redaction, so none was kept."
fi
mv "$tmp" "$dir/$name.json"
echo "Kept a summary of the $name step's transcript ($source, credentials redacted)."
