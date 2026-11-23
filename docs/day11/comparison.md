# Day 11: Qodo's review of PR #20, before and after the review instructions

## What was compared

- **Before:** Qodo's review of PR #20 (opened by `shrooms08`, 2026-11-22) under the original setup. Saved verbatim in [`before-pr20.md`](before-pr20.md).
- **Change:** PR #30 added `[review_agent] issues_user_guidelines` and `compliance_user_guidelines` to `.pr_agent.toml`, merged 2026-11-23 09:12:09Z. The preset and the 30 rules were not changed.
- **After:** draft PR #31, "Day 11 replay of PR #20 (do not merge)", opened by `shrooms08` at 09:13:02Z, after the merge. (Qodo: a repository-root file "takes effect for pull requests created after the change is merged".)
  - Branch from PR #20's base `0797aaf`, with PR #20's two commits cherry-picked unchanged: `65d4a08` = `10fb4c8` and `84e30be` = `e6d21be`. The diffs and commit messages are byte-identical; only the hashes and committer times differ.
  - Description: PR #20's, verbatim, under one note line saying it is a replay.
  - Pushed one commit at a time, like PR #20, so Qodo reviewed the first commit alone and then the second. A first attempt pushed both at once. Qodo then saw only the already-fixed code and reported nothing, which says nothing about the config, so the branch was moved back to `65d4a08` and forward again.

## Findings, side by side

| Finding | Before (PR #20) | After (PR #31) | Verdict |
|---|---|---|---|
| A failed read can rebuild an existing PR (`.github/polson/phase.sh:109`) | Reliability, **Medium** (`remediation_recommended`), raised on `10fb4c8`, resolved by `e6d21be` | Reliability, **High** (`action_required`), raised on `65d4a08` (same content), resolved by `84e30be` (same content as `e6d21be`) | **More useful.** Same bug, same line, caught again and resolved by the same fix. Severity is now High, and the description names the missing check the fix added (see the example below). |
| Agent may have edited .github files (`.github/polson/phase.sh:105`) | Security, **Medium**, raised on `10fb4c8`, **still pending**; cites ticket #18 and the Claude co-author trailer | **Not raised** | **Disappeared, as intended.** It flagged an owner-supervised `.github/` change, which the product decision allows. Before, it was a false positive that held the quality gate until a person dismissed it. |
| New: changes that give the unattended agent a new way to merge, push, pick a push target, run a branch's script or read a secret | n/a | No such finding | **Not tested.** PR #20 gives the agent no new capability, so this replay cannot show whether the catch works. |

## Example: the same bug, before and after

Before (PR #20, `10fb4c8`, Medium):

> `find_pr` does not check whether `found=$(cat)` succeeds, so a failed read can leave `found` empty while `count` remains valid. If `cat` is unavailable or fails after jq counts one matching PR, the `find-pr` command selects `next=build` instead of failing the step.

After (PR #31, `65d4a08`, High):

> `find_pr` leaves `found` empty when `cat` fails, but does not check that read or verify that the number of PR lines matches `count`. With one matching PR, the valid count survives while the missing record makes the `find-pr` dispatcher select `next=build` instead of stopping.

The "after" wording adds "or verify that the number of PR lines matches `count`". That is the check `e6d21be` actually added to fix it. Its evidence also cites `pr_knowledge: 20`, so Qodo drew on PR #20's earlier review (see "Other differences").

The finding that disappeared (PR #20, still pending):

> The `find_pr` rewrite in `.github/polson/phase.sh` is attributed to a person in the PR description, but the commit carries a `Co-Authored-By: Claude Opus 5.5` trailer and the description ends with 'Generated with Claude Code'. The ticket bars the agent from editing `.github/`, so the PR metadata does not establish that a person made this change, and a reviewer cannot confirm the restriction was respected from the PR alone.

## Feedback versus display

- **In the feedback itself:**
  - The `.github/` finding is no longer raised.
  - The bug's severity went from Medium to High.
  - The bug's description now names the missing line-count check.
  - The bug's evidence cites Qodo's knowledge of PR #20.
- **Only in how it is displayed:**
  - The open finding's badge went from Medium to High.
  - The count badge went from `📎 Requirement gaps (1)` (the `.github/` finding, whose record category is Security) to `🐞 Bugs (1)`.
  - The title wording went from "can rebuild" to "rebuilds".
  - The resolved entry shows `High` instead of `Medium`.
  - PR #31 has no "PR Summary by Qodo" comment. That is because each review was requested with `/agentic_review` on a draft, which posts only the review, not because of the config.

## Other differences between the runs

- **Review effort:** standard on both PR #20 runs and all four PR #31 runs. Nothing suggests the preset changed.
- **`review_complete`:** false on every run, before and after, including the first run on the fresh PR #31. So it is not caused by the config, and it is not only "sticky after an earlier run": this change itself gets `false`.
- **Trigger:** PR #20 was reviewed automatically on each push. Qodo did not review the draft PR #31 by itself, so every PR #31 run was requested with `/agentic_review`. One extra run on `84e30be` was requested by mistake; it also found nothing.
- **Qodo's memory:** the after-finding cites `pr_knowledge: 20` ("the same failure pattern was previously identified in this file"). The replay is not blind. Some of the difference (the higher severity, perhaps the missing `.github/` finding, which was answered on PR #20) may come from that history, not only from the new instructions.
- **Did PR #31 use the new configuration?** Neither the record nor the comment says which configuration a run used. Supporting evidence only: PR #31 was created after the merge, and the `.github/` finding the instructions target did not appear.

## Conclusion

Fewer findings is not the measure here. The real bug was still found, at a higher severity and with a more precise description. The finding that disappeared was the false positive the product decision describes. The High catch for new agent capabilities has not been exercised yet.
