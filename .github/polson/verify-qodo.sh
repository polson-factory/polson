#!/usr/bin/env bash
# The verify-qodo job's decision (issue #26). The agent job ended with candidate-done
# for HEAD_SHA, and the qodo-record job read Qodo's review record for it (QODO_RUN,
# QODO_EFFORT). This job holds the issue-write token, so it never runs Qodo's code
# and has no Qodo key: Qodo's CLI ran on another runner, whose token can only read.
#
# Usage: bash verify-qodo.sh <issue>
# Needs GH_TOKEN, GH_REPO, RUN_URL; from the agent job: PR, HEAD_SHA, CI_DETAIL,
# ROUNDS; from the qodo-record job: QODO_RUN, QODO_EFFORT. Optional: CHECK_ONLY=1
# prints the decision and never reads or changes the issue (for a local check).
#
# It reads the issue's labels and the PR right before it decides, and again right
# before it sets agent-done (after the success comment). GitHub has no atomic label
# update, so the last read narrows the window to the label edit itself. The ticket
# is reviewed only if:
#   - it is still agent-working (a person may have taken it),
#   - the PR is still open and its head is still HEAD_SHA, and
#   - QODO_RUN is "complete": Qodo's latest run is a completed, complete,
#     non-skipped review of HEAD_SHA.
# Anything else is not reviewed (AGENTS.md rule 6). Reviewed: the finish comment,
# then agent-done. Not reviewed: a comment saying why, then needs-human. A failed
# GitHub call fails the job, and the hand-over job hands the ticket over.
set -euo pipefail

issue="${1:-}"
fail_input() { echo "::error::$1" >&2; exit 2; }
[[ "$issue" =~ ^[1-9][0-9]{0,9}$ ]] || fail_input "Usage: bash verify-qodo.sh <issue-number>"
: "${GH_REPO:?GH_REPO must be set to owner/name}"
[[ "${PR:-}" =~ ^[1-9][0-9]{0,9}$ ]] || fail_input "PR must be a pull request number, got: ${PR:-}"
[[ "${HEAD_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || fail_input "HEAD_SHA must be a full commit SHA, got: ${HEAD_SHA:-}"
check_only="${CHECK_ONLY:-}"
if [ -z "$check_only" ]; then
  [[ "${ROUNDS:-}" =~ ^[0-2]$ ]] || fail_input "ROUNDS must be 0, 1 or 2, got: ${ROUNDS:-}"
fi
# Values from other jobs reach issue comments: plain words and plain text only.
word_re='^[a-z][a-z_-]{0,30}$'
run="${QODO_RUN:-}"
[[ "$run" =~ $word_re ]] || run="unknown"
effort="${QODO_EFFORT:--}"
[[ "$effort" =~ $word_re ]] || effort="-"
ci_detail="${CI_DETAIL:-}"
ci_detail_re='^[A-Za-z0-9 .,=_-]{0,200}$'
[[ "$ci_detail" =~ $ci_detail_re ]] || ci_detail="unreadable"
run_url="${RUN_URL:-}"
short="${HEAD_SHA:0:7}"

gh_() { timeout 60 gh "$@"; }

# Not reviewed: comment first, then needs-human. If the comment fails, the issue
# stays agent-working, this job fails, and the hand-over job hands it over.
not_reviewed() {
  if [ -n "$check_only" ]; then
    echo "Not reviewed: $1"
    exit 0
  fi
  gh_ issue comment "$issue" --body "$(printf '%s\n\n%s\n\nRun: %s' \
    "Polson's agent stopped, so this needs a person." "$1" "$run_url")" \
    || { echo "::error::Could not comment on #$issue; leaving it agent-working." >&2; exit 1; }
  gh_ issue edit "$issue" --remove-label agent-working --add-label needs-human \
    || { echo "::error::Could not relabel #$issue." >&2; exit 1; }
  echo "Not reviewed: $1"
  exit 0
}

# Sets working (yes or no), pr_state and head from fresh reads. A failed read exits.
read_ticket() {
  working=yes
  if [ -z "$check_only" ]; then
    labels=$(gh_ issue view "$issue" --json labels --jq '.labels[].name') \
      || { echo "::error::Could not read the labels of #$issue." >&2; exit 1; }
    grep -qx 'agent-working' <<<"$labels" || working=no
  fi
  info=$(gh_ pr view "$PR" --json state,headRefOid --jq '"\(.state) \(.headRefOid)"') \
    || { echo "::error::Could not read PR #$PR." >&2; exit 1; }
  pr_state="${info%% *}"
  head="${info#* }"
}

read_ticket
if [ "$working" = no ]; then
  echo "#$issue is no longer agent-working; nothing to decide."
  exit 0
fi
# The agent job checked HEAD_SHA, and Qodo's record was read for it. Nothing may
# have changed since.
echo "PR #$PR: state $pr_state, head ${head:0:7}; checked $short. Qodo's latest run: $run, review effort: $effort."
if [ "$pr_state" != "OPEN" ] || [ "$head" != "$HEAD_SHA" ]; then
  not_reviewed "Pull request #$PR changed after the agent job checked $short (now: state $pr_state, head ${head:0:7}), so its checks no longer apply."
fi
if [ "$run" = skipped ]; then
  not_reviewed "Qodo skipped reviewing $short: its review record shows a skipped run (review effort: $effort), which is not a review. A person reviews pull request #$PR or accepts an exception in writing."
fi
if [ "$run" != complete ]; then
  not_reviewed "Qodo's review record does not show a complete review of $short (its latest run: $run, review effort: $effort). Pull request: #$PR."
fi

if [ -n "$check_only" ]; then
  echo "Reviewed: Qodo's review record shows a complete review of $short (review effort: $effort)."
  exit 0
fi
gh_ issue comment "$issue" --body "$(cat <<COMMENT
Polson's checks passed. This is ready for a person to review and decide whether to merge.

- Pull request: https://github.com/$GH_REPO/pull/$PR
- Head commit: $HEAD_SHA
- CI: $ci_detail
- Qodo: its review comment lists 0 open High or Medium findings, and its review record shows a complete review of $short (review effort: $effort)
- Fix rounds used: $ROUNDS of 2

The agent's latest report above lists each acceptance criterion with its evidence, and each Qodo finding with what it did.

Run: $run_url
COMMENT
)" || { echo "::error::Could not comment on #$issue; leaving it agent-working." >&2; exit 1; }
# The comment took a request: read again right before the label changes.
read_ticket
if [ "$working" = no ]; then
  gh_ issue comment "$issue" --body "A person changed this ticket's labels while Polson was verifying it, so Polson left them as they are. The comment above describes the checks of $short only." \
    || { echo "::error::Could not comment on #$issue." >&2; exit 1; }
  echo "#$issue is no longer agent-working; labels left as they are."
  exit 0
fi
if [ "$pr_state" != "OPEN" ] || [ "$head" != "$HEAD_SHA" ]; then
  not_reviewed "Pull request #$PR changed while Polson was verifying $short (now: state $pr_state, head ${head:0:7}). The comment above no longer applies."
fi
gh_ issue edit "$issue" --remove-label agent-working --add-label agent-done \
  || { echo "::error::Could not relabel #$issue." >&2; exit 1; }
echo "Reviewed: agent-done."
