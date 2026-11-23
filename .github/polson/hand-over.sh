#!/usr/bin/env bash
# Hands a ticket still labelled agent-working to a person, so no ticket is ever
# stranded there.
#
# Usage: bash hand-over.sh <agent|final> <issue>
#   agent  the agent job's last step, which always runs. Env: JOB_STATUS, STEPS,
#          CANDIDATE. After candidate-done (CANDIDATE=true and the job succeeded),
#          the verify-qodo job decides, so the ticket is left alone. Otherwise a
#          ticket still agent-working is handed over, as before.
#   final  the hand-over job, which always runs after verify-qodo. Env:
#          VERIFY_RESULT. A ticket still agent-working means verify-qodo did not
#          start, failed or was cancelled: it is handed over.
# Needs GH_TOKEN, GH_REPO and RUN_URL.
#
# Comment first. If the comment fails, the issue stays agent-working, this step
# fails, and the next run's left-behind check hands it over.
set -euo pipefail

stage="${1:-}"
issue="${2:-}"
if ! [[ "$stage" =~ ^(agent|final)$ ]] || ! [[ "$issue" =~ ^[1-9][0-9]{0,9}$ ]]; then
  echo "Usage: bash hand-over.sh <agent|final> <issue-number>" >&2
  exit 2
fi

labels=$(gh issue view "$issue" --json labels --jq '.labels[].name')
if ! grep -qx 'agent-working' <<<"$labels"; then
  echo "The issue is no longer agent-working; it was already handed over."
  exit 0
fi

if [ "$stage" = agent ]; then
  if [ "${JOB_STATUS:-}" = "success" ] && [ "${CANDIDATE:-}" = "true" ]; then
    echo "Candidate-done: the verify-qodo job checks Qodo's review record and sets the label."
    exit 0
  fi
  if [ "${JOB_STATUS:-}" != "success" ]; then
    why="The agent job ended with status \`${JOB_STATUS:-unknown}\` (${STEPS:-}). A step failed, timed out, or was cancelled."
  else
    why="The run finished without moving the issue to agent-done or needs-human (${STEPS:-})."
  fi
else
  result="${VERIFY_RESULT:-unknown}"
  [[ "$result" =~ ^[a-z_]{1,20}$ ]] || result="unknown"
  why="The verify-qodo job did not finish (result: \`$result\`), so nothing confirmed that Qodo reviewed the pull request."
fi

gh issue comment "$issue" --body "$(printf '%s\n\n%s\n\nRun: %s' \
  "Polson's agent stopped without finishing, so this needs a person." "$why" "${RUN_URL:-}")"
gh issue edit "$issue" --remove-label agent-working --add-label needs-human
