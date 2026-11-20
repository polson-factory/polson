# polson
No slop. An AI co-founder that ships one verified improvement every night.

## What Polson is

Polson works on your product while you sleep. Each night it picks one task, builds it,
has it independently reviewed and checked, then either ships it or stops and asks you.
In the morning you read a short report. "Polson" is "no slop" backwards: nothing ships unchecked.

## Run the morning report

Requires Node 20+.

```sh
npm install
npm run report -- fixtures/sample-escalated.json
```

This validates the night record, prints the report, and saves it to `reports/<date>.md`.
An invalid record prints each problem, writes nothing, and exits with code 1.
The records in `fixtures/` are samples, not real nights.

Other commands: `npm test`, `npm run typecheck`.
