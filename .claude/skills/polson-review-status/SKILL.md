---
name: polson-review-status
description: Use when asked whether a PR's Qodo review is real, complete and on the current head, or whether a PR meets Polson's quality gate.
---

# Polson review status

Reports whether one pull request in `shrooms08/polson` meets the quality gate in `AGENTS.md`. It checks whether Qodo really reviewed the PR's current head commit, and whether CI passed. It is read-only: never comment, label, push, merge, dismiss a finding, or change a file other than the report it writes.

## Inputs

- **PR number** (required). If the user didn't give one, ask. Never guess it.
- **Repository:** `shrooms08/polson`. Run every command from the root of a local clone of it.

## Context to read first

- `AGENTS.md`, section "Quality gate (definition of done)": what "done" means, and how Qodo's labels map. `action_required` is High, `remediation_recommended` is Medium, `informational` is Low. Any other, missing or unreadable label makes the review unknown.
- `AGENTS.md`, rule 6 (No Guessing): an error or unreadable input is "unknown", never a known state. Never fill a missing value with a guess. If a step can't give you a value, stop (see "Stop and ask").
- Why Qodo's comment isn't enough: Qodo's PR comment can't tell a skipped review from a real one. Its own review record can (issue #26, `docs/FACTORY.md` gap 10). A review is real only if the record's latest run is on the head commit, `completed`, `review_complete` true, and `review_effort` not `skip`.

## Stop and ask the human

Stop, show the command and its output, and ask the human what to do, without writing a report or a verdict, if:

- there is no local Qodo login (step 0);
- the PR is not found, or is not open (step 1);
- Qodo's review record is unreadable: `qodo-record.sh` prints `run=unknown`, or the findings JSON doesn't parse or says `qar_operation_result_truncated: true` (steps 4 and 5);
- any command exits non-zero, or prints something these steps don't describe.

## Steps

Run them in order. Set these once, in the same shell:

```bash
REPO=shrooms08/polson
N=<PR number>
```

### 0. Check the tools and the Qodo login

```bash
git rev-parse --show-toplevel
git remote get-url origin
gh auth status
command -v jq timeout qodo
qodo read whoami --json
```

The remote must point at `shrooms08/polson`. `qodo read whoami --json` must succeed and show a signed-in account. If it says you're not logged in, or fails, stop and ask: the human runs `qodo login` themselves. Never log in for them, and never print or store a key.

### 1. The PR's head commit and state

```bash
gh pr view "$N" --repo "$REPO" --json number,state,isDraft,headRefOid,headRefName,url
```

Record `headRefOid` as the head commit and its first 7 characters as the short SHA:

```bash
SHA=$(gh pr view "$N" --repo "$REPO" --json headRefOid --jq .headRefOid)
SHORT=${SHA:0:7}
```

If `state` is not `OPEN`, stop and ask. A draft PR is not reviewed by Qodo automatically: note `isDraft`, and if Qodo has no run on it, say so in the reason.

### 2. CI on the head commit

The required checks are `Node 24` and `Node 20.19.0` from GitHub Actions, app id 15368. A check with the same name from another app does not count.

```bash
gh api "repos/$REPO/commits/$SHA/check-runs?per_page=100" --paginate \
  --jq '.check_runs[] | select(.app.id == 15368) | select(.name == "Node 24" or .name == "Node 20.19.0") | "\(.name)\t\(.status)\t\(.conclusion)\t\(.id)"'
```

If a name appears more than once (a re-run), use the line with the highest id. CI passes only if both checks are present, `completed`, and `success`. A missing, queued, in-progress, failed or cancelled check means CI does not pass.

### 3. Qodo's comment, read by the workflow's own script (one poll)

Use the scripts as they are on `main`, not your working tree. Copy them to a temporary directory:

```bash
git fetch --quiet origin main
POLSON_TMP=$(mktemp -d)
for f in wait-for-pr.sh qodo-open-findings.sh qodo-record.sh verify-qodo.sh; do
  git show "origin/main:.github/polson/$f" > "$POLSON_TMP/$f"
done
```

Then one poll, read-only (it never comments, labels or pushes):

```bash
GH_REPO="$REPO" POLL_SECONDS=1 TIMEOUT_SECONDS=0 bash "$POLSON_TMP/wait-for-pr.sh" "$N"
```

Read the `poll 1 …` line:
- `head=` must equal `$SHORT`;
- `review@head=yes` means Qodo's review comment names the head commit;
- `busy=no` means no "Qodo is busy working" comment exists;
- `open_high_medium=` is the comment's count of open High or Medium findings, or `unknown`.

One poll always ends with `qodo=not-finished`, because the script needs two polls in a row to say "finished". So ignore the final `qodo=` line and use the poll line. If `open_high_medium=unknown`, Qodo's comment could not be read: the gate is not met.

### 4. Qodo's own review record for the head (check-only)

Read the record (this never calls GitHub):

```bash
GH_REPO="$REPO" PR="$N" HEAD_SHA="$SHA" VERIFY_ATTEMPTS=1 VERIFY_DELAY_SECONDS=0 \
  bash "$POLSON_TMP/qodo-record.sh"
```

It prints `attempt 1 …: head=<short> run=<state> effort=<effort>`, then `run=` and `effort=`. Only `run=complete` is a real, complete review of the head. Every other state is not:
- `skipped`: Qodo skipped the review;
- `started`: the run is still going;
- `older-commit`: the latest run is on another commit;
- `incomplete`: `review_complete` is false;
- `none`: no review yet.

`run=unknown` means the record is unreadable: stop and ask.

Then the same decision the `verify-qodo` job makes, in check-only mode. It reads the PR and prints a decision, and never touches an issue. The first argument is only checked as a number in this mode, so pass the PR number:

```bash
GH_REPO="$REPO" PR="$N" HEAD_SHA="$SHA" QODO_RUN=<run from above> QODO_EFFORT=<effort from above> CHECK_ONLY=1 \
  bash "$POLSON_TMP/verify-qodo.sh" "$N"
```

It prints `Reviewed: …` or `Not reviewed: <reason>`. Keep the reason word for word.

### 5. The findings, from Qodo's review record (Review Resolver)

```bash
qodo read pr-review-session findings --pr-url "https://github.com/$REPO/pull/$N" --extended --json > "$POLSON_TMP/findings.json"
jq '{session: .review_session, runs: .review_runs, truncated: (.qar_operation_result_truncated // false)}' "$POLSON_TMP/findings.json"
jq -r '.findings[] | [.action_level, .attribution_status, .git_sha[0:7], .title, "\(.location.file_path):\(.location.start_line)"] | @tsv' "$POLSON_TMP/findings.json"
```

First confirm the record is complete and has the fields this step reads. A truncated record can leave out findings, including open High or Medium ones, so `qar_operation_result_truncated` must be absent or false. The CLI documents them in its tool schema (`qodo read tools pr-review-session findings --json`): "Returns the consolidated Finding: id, title, description, category, action_level, attribution_status, git_sha, location (file_path, start_line, end_line, side)…". If any finding lacks `action_level`, `attribution_status`, `git_sha` or `title`, the record's format has changed: stop and ask. Don't report NOT DONE as if Qodo had found something.

```bash
jq -e '((.qar_operation_result_truncated // false) == false) and (.findings | type == "array") and (.review_runs | type == "array") and ([.findings[] | select((.action_level | type) != "string" or (.attribution_status | type) != "string" or (.git_sha | type) != "string" or (.title | type) != "string")] | length == 0)' "$POLSON_TMP/findings.json"
```

It must print `true`. Anything else (a truncated record, a missing list, a finding without these fields) means stop and ask.

Check:
- `review_session.commit_sha` equals `$SHA`. The latest run is the entry in `review_runs` whose `run_id` matches `review_session.run_id`. Its `status`, `review_effort` and `review_complete` must agree with step 4. If they disagree, stop and ask.
- **Open** findings are those whose `attribution_status` is `pending`, `partial_implementation`, `not_implemented` or `focus_areas_edited`. **Closed** findings are `implemented`, `full_implementation`, `dismissed`, `detected_after_merge` or `outdated`. Any other status is unknown.
- **Severity:** `action_required` is High, `remediation_recommended` is Medium, and `informational` is Low. Any other or missing `action_level` is unknown.
- Count open High and open Medium. List every Low, open or closed, by title.
- The count of open High plus open Medium must equal step 3's `open_high_medium`. If they differ, the comment and the record disagree, so the gate is not met. Say so.

### 6. Apply the quality gate

**GATE MET** only if every one of these holds:
1. CI passes on the head commit (step 2). CI runs `npm run typecheck` and `npm test`.
2. Qodo's comment names the head, isn't busy, and reads as a number (step 3).
3. Qodo's record shows a real, complete review of the head: `run=complete`, and `verify-qodo.sh` printed `Reviewed:` (step 4).
4. No open High and no open Medium finding, and no finding with an unknown status or severity (step 5).
5. Every Low finding is listed in the report.

Otherwise the verdict is **NOT DONE**, with the exact reason: every condition that fails, each with the value that failed it.

This skill can't judge whether an open High or Medium finding is valid. Under the quality gate, a finding the author disputes still blocks "done" until a person dismisses it in Qodo. So every open High or Medium blocks.

## Output

Write the report to `docs/review-status/pr-<N>-<SHORT>.md`, for example `docs/review-status/pr-33-09c28e2.md`. Create the directory if needed. Don't commit it unless the human asks. Show the same content in your reply.

```markdown
# PR #<N> review status (<UTC date and time>)

| Head | CI | Qodo run commit | Effort | review_complete | Open High | Open Medium | Low findings |
|---|---|---|---|---|---|---|---|
| <SHORT> | <Node 24: …; Node 20.19.0: …> | <short commit of the latest run> | <effort> | <true/false> | <count> | <count> | <titles, or "none"> |

**Verdict: GATE MET** or **Verdict: NOT DONE**: <the exact reason or reasons>

## Evidence
- `gh pr view`: state <state>, draft <true/false>, head <SHA>
- CI: <each check, status and conclusion>
- `wait-for-pr.sh`, one poll: <the poll line, verbatim>
- `qodo-record.sh`: <the attempt line, verbatim>
- `verify-qodo.sh` (check-only): <its decision line, verbatim>
- Open High and Medium findings: <title, severity, status, location>, or "none"
- Low findings: <title, status, location>, or "none"
```

Every cell comes from a command's output. Never infer a value. If a step didn't give one, you should already have stopped and asked.

Afterwards remove the temporary copies: `rm -r "$POLSON_TMP"`.

## Never

- Comment, label, push, merge, re-run CI, request a Qodo review (`/agentic_review`), dismiss or mark a finding, or edit any file other than the report.
- Log in to Qodo or GitHub for the human, or print, copy or store a key or token.
- Report GATE MET from Qodo's comment alone, from zero findings alone, or from a review of an older commit.
