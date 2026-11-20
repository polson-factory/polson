import { z } from "zod";

/**
 * A record of one night's work: the task Polson picked, how it was reviewed
 * and checked, and what happened in the end.
 *
 * The schema enforces the product's core promise: a record can only say
 * "shipped" if it was verified, meaning an approved review and at least one
 * check, with every check passing.
 *
 * Error messages are written to follow the field path, e.g.
 * `reason: is required when outcome is "blocked"`.
 */

// No `m` flag, so `^` and `$` anchor to the whole string. The length check
// makes that explicit: no trailing "\n" or "\r" can slip into a report filename.
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_LENGTH = "YYYY-MM-DD".length;

function isRealCalendarDate(value: string): boolean {
  if (value.length !== DATE_LENGTH) return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/** A trimmed, non-empty string with a readable message when it is missing. */
function requiredText(missingMessage = "is required") {
  return z
    .string({
      error: (issue) => (issue.input === undefined ? missingMessage : "must be text"),
    })
    .trim()
    .min(1, "must not be empty");
}

const DateSchema = z
  .string({
    error: (issue) => (issue.input === undefined ? "is required (YYYY-MM-DD)" : "must be text"),
  })
  .refine(isRealCalendarDate, "must be a real calendar date in YYYY-MM-DD format");

const TaskSchema = z.strictObject(
  {
    id: requiredText(),
    title: requiredText(),
    acceptanceCriteria: z
      .array(requiredText(), { error: "is required (a list of at least one criterion)" })
      .min(1, "must list at least one criterion"),
  },
  { error: "is required" },
);

const PullRequestSchema = z.strictObject({
  number: z.number({ error: "must be a number" }).int().positive("must be a positive integer"),
  // Only http(s) links reach the report. `normalize` stores the parsed href,
  // which is percent-encoded and cannot contain whitespace, "<" or ">".
  url: z.url({
    protocol: /^https?$/,
    normalize: true,
    error: "must be a valid http or https URL",
  }),
});

const ReviewSchema = z.strictObject({
  reviewer: requiredText(),
  verdict: z.enum(["approved", "changes_requested"], {
    error: 'must be "approved" or "changes_requested"',
  }),
  findings: z.number({ error: "must be a number" }).int().nonnegative("must be zero or more"),
});

const CheckSchema = z.strictObject({
  name: requiredText(),
  status: z.enum(["pass", "fail"], { error: 'must be "pass" or "fail"' }),
  detail: requiredText().optional(),
});

const commonFields = {
  date: DateSchema,
  task: TaskSchema,
  pullRequest: PullRequestSchema.optional(),
  review: ReviewSchema.optional(),
  checks: z.array(CheckSchema, { error: "is required (use [] if no checks ran)" }),
};

const ShippedRecord = z.strictObject({
  ...commonFields,
  outcome: z.literal("shipped"),
});

const BlockedRecord = z.strictObject({
  ...commonFields,
  outcome: z.literal("blocked"),
  reason: requiredText('is required when outcome is "blocked"'),
});

const EscalatedRecord = z.strictObject({
  ...commonFields,
  outcome: z.literal("escalated"),
  reason: requiredText('is required when outcome is "escalated"'),
  questionForHuman: requiredText('is required when outcome is "escalated"'),
});

export const NightRecordSchema = z
  .discriminatedUnion("outcome", [ShippedRecord, BlockedRecord, EscalatedRecord], {
    error: 'must be "shipped", "blocked", or "escalated"',
  })
  .superRefine((record, ctx) => {
    if (record.outcome !== "shipped") return;

    // "Shipped" means verified: an approved review, at least one check, and
    // every check passing. Each missing piece is reported on its own.
    if (!record.review) {
      ctx.addIssue({
        code: "custom",
        path: ["review"],
        message: 'is required when outcome is "shipped" (an approved review)',
      });
    }

    if (record.checks.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["checks"],
        message: 'must include at least one check when outcome is "shipped"',
      });
    }

    record.checks.forEach((check, index) => {
      if (check.status === "fail") {
        ctx.addIssue({
          code: "custom",
          path: ["checks", index, "status"],
          message: `outcome cannot be "shipped" while check "${check.name}" failed`,
        });
      }
    });

    if (record.review?.verdict === "changes_requested") {
      ctx.addIssue({
        code: "custom",
        path: ["review", "verdict"],
        message: 'outcome cannot be "shipped" while the reviewer requested changes',
      });
    }
  });

export type NightRecord = z.infer<typeof NightRecordSchema>;
export type Outcome = NightRecord["outcome"];

export type ParseResult =
  | { ok: true; record: NightRecord }
  | { ok: false; problems: string[] };

/** Validate unknown input and return either the record or a readable list of problems. */
export function parseNightRecord(input: unknown): ParseResult {
  const result = NightRecordSchema.safeParse(input);
  if (result.success) return { ok: true, record: result.data };
  return {
    ok: false,
    problems: result.error.issues.map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "record";
      return `${where}: ${issue.message}`;
    }),
  };
}
