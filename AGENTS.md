# Polson

## What this is

Polson is an AI co-founder that ships one verified improvement every night. Each night it takes one ticket, builds it, gets it independently reviewed and checked, then either ships it or stops and asks the human. The human reads a morning report. "Polson" is "no slop" backwards: nothing ships unchecked.

## Setup and verification

- Node: 20.19+, 22.12+, or 24+
- Install: `npm install`
- Typecheck: `npm run typecheck`
- Tests: `npm test`
- Render a sample morning report: `npm run report -- fixtures/sample-escalated.json`
- A change is not done until typecheck and tests pass.

## Rules

### 1. The No Slop Rule

- **Rule:** A night may be recorded as "shipped" only when it has an approved review, at least one check, and every check passed. Never loosen this.
- **Applies to:** `src/night-record.ts` and any code that decides or records a night's outcome.
- **Why:** This is Polson's core promise. Qodo's first review of PR #1 found a "shipped" record could exist with no review and no checks. That is the exact slop Polson exists to prevent.

### 2. Never weaken a test to get green

- **Rule:** Do not delete, skip, loosen, or rewrite a test to make it pass. Fix the code, or stop and explain why the test is wrong. When you add a test for a rule, break the code briefly to prove the test fails, then restore it.
- **Applies to:** Everything under `test/` and any check the factory runs.
- **Why:** An agent that edits its own checks can make anything look verified.

### 3. Record text is untrusted

- **Rule:** Escape every free-text field from a night record before rendering it, using the shared helper in `src/plain-text.ts`. Never build report structure from record text.
- **Applies to:** `src/morning-report.ts` and any future code that renders records, issues, or agent output.
- **Why:** Agents will write these records. Qodo showed on PR #1 that text inside a record could forge a "## Review" section in the report.

### 4. Prove a finding before you fix it

- **Rule:** Reproduce every review finding, or trace it in the code, before changing anything. If it does not reproduce, add a test that shows the correct behaviour and explain on the PR instead of "fixing" it.
- **Applies to:** Every PR and every review finding, from Qodo or anyone else.
- **Why:** On PR #1 Qodo reported that dates with a trailing newline were accepted. They were not. Blindly fixing reviewer output is another kind of slop.

### 5. One ticket, one branch, one PR

- **Rule:** Work on a branch named after the ticket, never commit to main, and put the ticket link and its acceptance criteria in the PR description. Never merge unless the task explicitly gives a merge rule and the PR meets it.
- **Applies to:** All work by any agent in this repo.
- **Why:** Each change stays reviewable and traceable to what was asked, and a human or an explicit gate decides what reaches main.

## Deferred issues

- [#2](https://github.com/shrooms08/polson/issues/2): Report writes are not atomic; a failed write can truncate an existing report.
- [#3](https://github.com/shrooms08/polson/issues/3): A sample run can overwrite a real night's report that has the same date.
