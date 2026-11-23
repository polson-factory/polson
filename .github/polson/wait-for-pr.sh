#!/usr/bin/env bash
# Waits until CI and Qodo have both finished with a pull request's head commit.
# Read-only: it never comments, labels, or pushes.
#
# Usage: bash wait-for-pr.sh <pr-number>
# Needs GH_TOKEN and GH_REPO (owner/name), and the Qodo CLI (`qodo`) on PATH and
# signed in: in the workflow with QODO_API_KEY and QODO_BASE_URL (see
# with-qodo.sh), locally with `qodo login`. Optional: POLL_SECONDS (default 60),
# TIMEOUT_SECONDS (default 900), REQUIRED_CHECKS (default "Node 24,Node 20.19.0").
#
# CI is finished when every required check run from GitHub Actions on the head
# commit has completed.
#
# Qodo is finished when all of these hold on two polls in a row, with the same
# open count both times:
#   - its "Code Review by Qodo" comment names the head commit,
#   - that review can be read: qodo-open-findings.sh checks that its finding
#     counts (bugs, rule violations, requirement gaps) match the findings it lists,
#   - no "Qodo is busy working" comment exists,
#   - and Qodo's own review record (read with the Qodo CLI) says its latest run is
#     on the head commit, completed, complete, and not skipped.
# The last check exists because the comment cannot tell a skipped review from a
# real one: on PR #25 Qodo skipped all three runs, yet its comment said "Great, no
# issues found!" and named the head commit, word for word like PR #11's real
# review (issue #26). A skipped review is not a review. Anything else in the
# record (no review yet, a run still going, an older commit, a CLI error,
# unreadable output) also counts as not finished.
# The summary ("PR Summary by Qodo", "Assessed commit <head>") is logged but not
# required: after `/agentic_review`, Qodo posts only the review (PR #11). The
# review must itself name the head commit, because the open count comes from it.
# On PR #10 the summary named a new commit about three minutes before the review
# listed that commit's findings, so a summary alone would be a guess.
# Qodo's comments are told apart by their opening heading. Anything unreadable
# counts as not finished.
#
# Prints one line per poll, then writes these outputs to $GITHUB_OUTPUT (or to
# stdout when GITHUB_OUTPUT is unset):
#   pr_state   OPEN, CLOSED or MERGED
#   head_sha   the head commit that was checked
#   ci         success | failure | pending (pending: not finished in time)
#   ci_detail  each required check and its conclusion
#   qodo       finished | not-finished
#   qodo_open  open High or Medium findings on the head commit: a number, or unknown
#   qodo_run   Qodo's latest run as its review record shows it: complete, skipped,
#              started (or another unfinished status), older-commit, none, or unknown
set -euo pipefail

pr="${1:-}"
if ! [[ "$pr" =~ ^[1-9][0-9]{0,9}$ ]]; then
  echo "Usage: bash wait-for-pr.sh <pr-number>" >&2
  exit 2
fi
: "${GH_REPO:?GH_REPO must be set to owner/name}"
poll="${POLL_SECONDS:-60}"
timeout_s="${TIMEOUT_SECONDS:-900}"
IFS=',' read -r -a required <<<"${REQUIRED_CHECKS:-Node 24,Node 20.19.0}"
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# The GitHub Actions app. Only its check runs count, so a check run with the same
# name from another app cannot stand in for CI.
ACTIONS_APP_ID=15368
QODO_LOGIN="qodo-code-review[bot]"

gh_() { timeout 60 gh "$@"; }

# Qodo's comments are told apart by their opening heading, never by searching the
# whole body: a summary or review quotes the PR's text and code, which can contain
# any of these phrases (this script does).
QODO_KIND='def heading: sub("^\\s+"; "") | split("\n")[0];
  .[] | select(.user.login == "'"$QODO_LOGIN"'") | .body as $b | ($b | heading) as $h
  | if ($h | startswith("<h3>Qodo is busy working</h3>")) then "busy"
    elif ($h | startswith("<h3>PR Summary by Qodo</h3>")) then "summary " + ($b | contains($summary_mark) | tostring)
    elif ($h | startswith("<h3>Code Review by Qodo</h3>")) then "review " + ($b | contains($review_mark) | tostring)
    else "other" end'

# Prints one line per Qodo comment: busy, summary true|false, review true|false, or
# other, where true means the comment names commit $sha. Reads comments JSON on stdin.
qodo_kinds() {
  jq -rs --arg summary_mark "Assessed commit <a href=\"https://github.com/$GH_REPO/commit/$sha\"" \
    --arg review_mark "<!-- https://github.com/$GH_REPO/commit/$sha -->" \
    "add | $QODO_KIND"
}

# Prints the body of Qodo's review comment for commit $sha, from comments JSON on stdin.
qodo_review_body() {
  jq -rs --arg login "$QODO_LOGIN" --arg review_mark "<!-- https://github.com/$GH_REPO/commit/$sha -->" \
    'add | .[] | select(.user.login == $login) | .body
     | select(sub("^\\s+"; "") | startswith("<h3>Code Review by Qodo</h3>"))
     | select(contains($review_mark))'
}

# Prints "<state> <effort>" for Qodo's latest run on this PR, from its review record:
#   complete <effort>   a finished, complete, non-skipped review of commit $sha
#   skipped <effort>    a skipped run (review_effort "skip", or status "skipped")
#   <status> <effort>   a run that has not completed (for example "started")
#   older-commit ...    the latest run is on another commit
#   incomplete ...      completed but review_complete is not true
#   none -              no review yet (review_session is null)
#   unknown -           the CLI failed, or its output is unreadable or truncated
# Only "complete" lets Qodo count as finished. The CLI's stderr (a trace id, or an
# error) goes to the log; only its exit code and stdout are read.
qodo_run_state() {
  local record state
  local line_re='^[a-z][a-z_-]{0,30} ([a-z][a-z_-]{0,30}|-)$'
  if ! record=$(timeout 60 qodo read pr-review-session findings \
      --pr-url "https://github.com/$GH_REPO/pull/$pr" --extended --json); then
    echo "unknown -"
    return 0
  fi
  # -s reads the whole output as one array, so jq prints nothing unless all of it
  # is JSON, and anything but exactly one document is unreadable.
  if ! state=$(jq -rs --arg sha "$sha" '
    # Values from the record reach step outputs and issue comments: plain words only.
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

# One poll. Sets pr_state, sha, ci, ci_detail, the Qodo flags and open. Returns non-zero
# if a GitHub call failed, so the caller can retry on the next poll.
poll_once() {
  local info runs state name kinds comments
  info=$(gh_ pr view "$pr" --json state,headRefOid --jq '"\(.state) \(.headRefOid)"') || return 1
  pr_state="${info%% *}"
  sha="${info#* }"
  [ "$pr_state" = "OPEN" ] || return 0

  runs=$(gh_ api "repos/$GH_REPO/commits/$sha/check-runs?per_page=100" --paginate \
    --jq ".check_runs[] | select(.app.id == $ACTIONS_APP_ID) | {id, name, status, conclusion}") || return 1
  runs=$(jq -s '.' <<<"$runs")
  ci="success"
  ci_detail=""
  for name in "${required[@]}"; do
    # The latest run of that name, in case a check was re-run.
    state=$(jq -r --arg n "$name" \
      '[.[] | select(.name == $n)] | sort_by(.id) | last
       | if . == null then "missing" elif .status != "completed" then .status else .conclusion end' <<<"$runs")
    ci_detail="${ci_detail:+$ci_detail, }$name=$state"
    case "$state" in
      success) ;;
      missing | queued | in_progress | waiting | requested | pending) ci="pending" ;;
      *) [ "$ci" = "pending" ] || ci="failure" ;;
    esac
  done

  comments=$(gh_ api "repos/$GH_REPO/issues/$pr/comments?per_page=100" --paginate) || return 1
  kinds=$(qodo_kinds <<<"$comments") || return 1
  summary=no review=no busy=no open=unknown
  if grep -qx 'summary true' <<<"$kinds"; then summary=yes; fi
  if grep -qx 'review true' <<<"$kinds"; then review=yes; fi
  if grep -qx 'busy' <<<"$kinds"; then busy=yes; fi
  if [ "$review" = yes ]; then
    open=$(qodo_review_body <<<"$comments" | bash "$here/qodo-open-findings.sh") || open=unknown
  fi
  local run_state
  run_state=$(qodo_run_state)
  run="${run_state%% *}"
  effort="${run_state#* }"
  return 0
}

emit() {
  local out="${GITHUB_OUTPUT:-/dev/stdout}"
  {
    echo "pr_state=$pr_state"
    echo "head_sha=$sha"
    echo "ci=$ci"
    echo "ci_detail=$ci_detail"
    echo "qodo=$qodo"
    echo "qodo_open=$qodo_open"
    echo "qodo_run=$run"
  } >>"$out"
}

start=$(date +%s)
deadline=$((start + timeout_s))
stable=0
last_sha=""
n=0
pr_state="" sha="" ci="pending" ci_detail="" qodo="not-finished" qodo_open="unknown"
summary=no review=no busy=no open=unknown last_open="" run=unknown effort=-

while :; do
  n=$((n + 1))
  now=$(date -u +%H:%M:%S)
  if ! poll_once; then
    echo "poll $n $now: a GitHub request failed; trying again next poll."
    stable=0
  elif [ "$pr_state" != "OPEN" ]; then
    echo "poll $n $now: PR #$pr is $pr_state. Stopping."
    ci="pending"
    break
  else
    if [ -n "$last_sha" ] && [ "$sha" != "$last_sha" ]; then
      echo "The head commit changed from ${last_sha:0:7} to ${sha:0:7}; checking Qodo again from the start."
      stable=0
    fi
    last_sha="$sha"
    if [ "$review" = yes ] && [ "$open" != unknown ] && [ "$busy" = no ] && [ "$run" = complete ]; then
      if [ "$stable" -gt 0 ] && [ "$open" != "$last_open" ]; then stable=0; fi
      stable=$((stable + 1))
      last_open="$open"
    else
      stable=0
    fi
    echo "poll $n $now: head=${sha:0:7} ci=$ci [$ci_detail] qodo: summary@head=$summary review@head=$review busy=$busy run=$run effort=$effort open_high_medium=$open ready_polls=$stable"
    if [ "$ci" != "pending" ] && [ "$stable" -ge 2 ]; then
      break
    fi
  fi
  if [ $(($(date +%s) + poll)) -gt "$deadline" ]; then
    echo "Gave up after $((($(date +%s) - start) / 60)) minutes."
    break
  fi
  sleep "$poll"
done

if [ "$pr_state" = "OPEN" ] && [ "$stable" -ge 2 ]; then
  qodo="finished"
  qodo_open="$last_open"
fi

echo "Result: head=${sha:-none} ci=$ci ($ci_detail) qodo=$qodo run=$run effort=$effort open_high_medium=$qodo_open"
emit
