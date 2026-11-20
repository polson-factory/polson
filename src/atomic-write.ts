import { randomBytes } from "node:crypto";
import { link, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Write a file so the target path ends up holding either the complete new
 * content or exactly what it held before. Never a partial file.
 *
 * 1. Create the folder if needed.
 * 2. Write the content to a temporary file in the same folder (created
 *    exclusively), flush it to disk, and close it.
 * 3. Put it in place:
 *    - without `overwrite`, hard-link the temp file to the target. `link`
 *      fails with EEXIST if anything is already at the target (a file, a
 *      folder, or a symlink, even a dangling one), so checking for an existing
 *      report and putting the new one in place are a single atomic step. Two
 *      runs at the same moment cannot both succeed.
 *    - with `overwrite`, rename the temp file onto the target. `rename`
 *      replaces the target's directory entry itself, so a symlink at the target
 *      is replaced, never written through.
 * 4. Always remove the temp file, on success and on every failure path.
 */

/** Marks Polson's temporary files, e.g. `.2026-11-19.md.polson-tmp-4242-1a2b3c4d5e6f`. */
export const TEMP_MARKER = ".polson-tmp-";

/** The filesystem calls used, injectable so tests can force failures. */
export interface WriteFs {
  mkdir: typeof mkdir;
  open: typeof open;
  link: typeof link;
  rename: typeof rename;
  rm: typeof rm;
}

export const realFs: WriteFs = { mkdir, open, link, rename, rm };

export type WriteOutcome = {
  /** "exists": nothing was written because the target already existed. */
  status: "written" | "exists";
  /** Set only if the temp file could not be removed afterwards. */
  leftoverTemp?: string;
};

/**
 * Error codes `link` returns when the filesystem cannot make hard links
 * (exFAT and FAT32 return ENOTSUP on macOS; Linux uses EPERM).
 */
const NO_HARD_LINKS = new Set(["ENOTSUP", "EOPNOTSUPP", "EPERM"]);

/** A failed write. Nothing at the target was changed. */
export class AtomicWriteError extends Error {
  constructor(
    cause: unknown,
    readonly leftoverTemp?: string,
    /**
     * "no-hard-links": the folder's filesystem cannot make hard links, which a
     * write without overwrite needs to refuse an existing report atomically.
     */
    readonly reason?: "no-hard-links",
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "AtomicWriteError";
  }

  get code(): string | undefined {
    return (this.cause as { code?: string } | undefined)?.code;
  }
}

export async function writeFileAtomically(
  target: string,
  content: string,
  options: { overwrite: boolean },
  fs: WriteFs = realFs,
): Promise<WriteOutcome> {
  const dir = dirname(target);
  const temp = join(
    dir,
    `.${basename(target)}${TEMP_MARKER}${process.pid}-${randomBytes(6).toString("hex")}`,
  );

  let status: WriteOutcome["status"] | undefined;
  let failure: unknown;
  let reason: AtomicWriteError["reason"];
  try {
    await fs.mkdir(dir, { recursive: true });

    const handle = await fs.open(temp, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (options.overwrite) {
      await fs.rename(temp, target);
      status = "written";
    } else {
      try {
        await fs.link(temp, target);
        status = "written";
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "EEXIST") {
          status = "exists";
        } else {
          // No safe fallback: without a hard link, refusing an existing report
          // and placing the new one cannot be a single atomic step.
          if (code !== undefined && NO_HARD_LINKS.has(code)) reason = "no-hard-links";
          throw error;
        }
      }
    }
  } catch (error) {
    failure = error;
  }

  // After a rename the temp name is already gone; `force` makes that a no-op.
  const cleanupFailed = await fs.rm(temp, { force: true }).then(
    () => false,
    () => true,
  );
  const leftoverTemp = cleanupFailed ? temp : undefined;

  if (failure !== undefined || status === undefined) {
    throw new AtomicWriteError(failure, leftoverTemp, reason);
  }
  return leftoverTemp ? { status, leftoverTemp } : { status };
}
