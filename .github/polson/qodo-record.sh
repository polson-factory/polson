#!/usr/bin/env bash
# Reads Qodo's own review record for the head commit the agent job checked, for the
# qodo-record job in polson-agent.yml (issue #26). Qodo's PR comment cannot tell a
# skipped review from a real one (on PR #25 the skipped review's comment matched
# PR #11's real review apart from the commit); its review record can.
#
# Usage: bash qodo-record.sh
# Needs GH_REPO, PR and HEAD_SHA, and the Qodo CLI (`qodo` on PATH) signed in:
# QODO_API_KEY and QODO_BASE_URL in the job, or a local `qodo login`. Optional:
# VERIFY_ATTEMPTS (default 5) and VERIFY_DELAY_SECONDS (default 60): the record can
# lag Qodo's comment, so a run that is not yet complete or skipped is read again.
# Writes to $GITHUB_OUTPUT (or stdout):
#   run     complete, skipped, started (or another unfinished status),
#           older-commit, incomplete, none, or unknown
#   effort  Qodo's review effort for that run (for example lite or extended), or -
# Only run=complete is a review. The verify-qodo job decides; this script never
# calls GitHub, and its job's token can only read contents.
#
# The Qodo CLI runs with an allowlist of environment variables (qodo_env), so it
# never receives GH_TOKEN, GITHUB_TOKEN or the ACTIONS_* token variables.
set -euo pipefail

fail_input() { echo "::error::$1" >&2; exit 2; }
: "${GH_REPO:?GH_REPO must be set to owner/name}"
[[ "${PR:-}" =~ ^[1-9][0-9]{0,9}$ ]] || fail_input "PR must be a pull request number, got: ${PR:-}"
[[ "${HEAD_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || fail_input "HEAD_SHA must be a full commit SHA, got: ${HEAD_SHA:-}"
attempts="${VERIFY_ATTEMPTS:-5}"
delay="${VERIFY_DELAY_SECONDS:-60}"
[[ "$attempts" =~ ^[1-9][0-9]?$ ]] || fail_input "VERIFY_ATTEMPTS must be 1 to 99, got: $attempts"
[[ "$delay" =~ ^[0-9]{1,4}$ ]] || fail_input "VERIFY_DELAY_SECONDS must be a number of seconds, got: $delay"
out="${GITHUB_OUTPUT:-/dev/stdout}"
sha="$HEAD_SHA"

# Runs a Qodo command with only the variables it needs. Optional ones are passed
# only when set: the job sets QODO_HOME, the key, the base URL and the no-update
# and no-keychain flags; a local run signs in from the keychain under HOME.
qodo_env() {
  local vars=("PATH=$PATH" "HOME=${HOME:?HOME must be set}") name
  for name in QODO_HOME QODO_API_KEY QODO_BASE_URL QODO_NO_KEYCHAIN \
      QODO_DISABLE_AUTOUPDATE QODO_DISABLE_SKILLS_AUTOUPDATE CI TMPDIR; do
    if [ -n "${!name:-}" ]; then vars+=("$name=${!name}"); fi
  done
  env -i "${vars[@]}" "$@"
}

# Prints "<state> <effort>" for Qodo's latest run on this PR, from its review record:
#   complete <effort>   a finished, complete, non-skipped review of commit $sha
#   skipped <effort>    a skipped run (review_effort "skip", or status "skipped")
#   <status> <effort>   a run that has not completed (for example "started")
#   older-commit ...    the latest run is on another commit
#   incomplete ...      completed but review_complete is not true
#   none -              no review yet (review_session is null)
#   unknown -           the CLI failed, or its output is unreadable or truncated
# The CLI's stderr (a trace id, or an error) goes to the log; only its exit code and
# stdout are read.
qodo_run_state() {
  local record state
  local line_re='^[a-z][a-z_-]{0,30} ([a-z][a-z_-]{0,30}|-)$'
  if ! record=$(qodo_env timeout 60 qodo read pr-review-session findings \
      --pr-url "https://github.com/$GH_REPO/pull/$PR" --extended --json); then
    echo "unknown -"
    return 0
  fi
  # -s reads the whole output as one array, so jq prints nothing unless all of it
  # is JSON, and anything but exactly one document is unreadable.
  if ! state=$(jq -rs --arg sha "$sha" '
    # Values from the record reach the log and issue comments: plain words only.
    def word: tostring | if test("^[a-z][a-z_-]{0,30}$") then . else "unknown" end;
    def effort: if .review_effort == null then "-" else .review_effort | word end;
    if length != 1 then "unknown -"
    else .[0]
    | if type != "object" or .qar_operation_result_truncated == true then "unknown -"
      elif .review_session == null then "none -"
      else .review_session as $s
        | [.review_runs[]? | select(.run_id == $s.run_id)] as $matches
        | ($matches[0] // null) as $r
        # The latest run is the one with the session run_id: it must exist and be unique.
        | if $s.run_id == null or ($matches | length) != 1 then "unknown -"
          elif $s.commit_sha != $sha or $r.commit_sha != $sha then "older-commit \($r | effort)"
          elif $r.review_effort == "skip" or $s.status == "skipped" then "skipped \($r | effort)"
          elif $s.status != "completed" or $r.status != "completed" then "\($s.status | word) \($r | effort)"
          elif $s.review_complete != true or $r.review_complete != true then "incomplete \($r | effort)"
          elif ($r.review_effort | type) != "string" or ($r | effort) == "unknown" then "unknown -"
          else "complete \($r | effort)"
          end
      end
    end' <<<"$record" 2>/dev/null); then # jq fails only when the output is not JSON of the shape read above: unreadable, so unknown.
    state="unknown -"
  fi
  # Exactly one "<state> <effort>" line, or the record was not read.
  [[ "$state" =~ $line_re ]] || state="unknown -"
  echo "$state"
}

run=unknown effort=-
for ((attempt = 1; attempt <= attempts; attempt++)); do
  state=$(qodo_run_state)
  run="${state%% *}"
  effort="${state#* }"
  echo "attempt $attempt $(date -u +%H:%M:%S): head=${HEAD_SHA:0:7} run=$run effort=$effort"
  case "$run" in complete | skipped) break ;; esac
  if [ "$attempt" -lt "$attempts" ]; then sleep "$delay"; fi
done

{
  echo "run=$run"
  echo "effort=$effort"
} >>"$out"
