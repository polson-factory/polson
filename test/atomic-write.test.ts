import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realFs, TEMP_MARKER, writeFileAtomically, type WriteFs } from "../src/atomic-write.js";
import { runReport } from "../src/cli.js";
import { fixturePath } from "./fixtures.js";

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

type Step = "mkdir" | "open" | "partial write" | "sync" | "link" | "rename";

/** The real filesystem, except that one step fails. */
function failingAt(step: Step): WriteFs {
  return {
    ...realFs,
    mkdir: (async (...args: Parameters<typeof realFs.mkdir>) => {
      if (step === "mkdir") throw fsError("EACCES");
      return realFs.mkdir(...args);
    }) as WriteFs["mkdir"],
    open: (async (...args: Parameters<typeof realFs.open>) => {
      if (step === "open") throw fsError("EMFILE");
      const handle = await realFs.open(...args);
      if (step !== "partial write" && step !== "sync") return handle;
      return {
        writeFile: async (content: string) => {
          if (step === "partial write") {
            // Half the report reaches the temp file, then the disk "fills up".
            await handle.writeFile(content.slice(0, Math.floor(content.length / 2)));
            throw fsError("ENOSPC");
          }
          return handle.writeFile(content);
        },
        sync: async () => {
          if (step === "sync") throw fsError("EIO");
          return handle.sync();
        },
        close: () => handle.close(),
      } as unknown as FileHandle;
    }) as WriteFs["open"],
    link: (async (...args: Parameters<typeof realFs.link>) => {
      if (step === "link") throw fsError("EIO");
      return realFs.link(...args);
    }) as WriteFs["link"],
    rename: (async (...args: Parameters<typeof realFs.rename>) => {
      if (step === "rename") throw fsError("EIO");
      return realFs.rename(...args);
    }) as WriteFs["rename"],
  };
}

describe("atomic report writes (#2)", () => {
  let cwd: string;
  let out: string;
  let err: string;
  const io = (fs?: WriteFs) => ({
    cwd,
    out: (text: string) => void (out += text),
    err: (text: string) => void (err += text),
    ...(fs ? { fs } : {}),
  });
  const sample = () => fixturePath("sample-escalated.json");
  const reportsDir = () => join(cwd, "reports");
  const reportFile = () => join(reportsDir(), "2026-11-19.md");
  const tempFiles = () =>
    existsSync(reportsDir()) ? readdirSync(reportsDir()).filter((name) => name.includes(TEMP_MARKER)) : [];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "polson-atomic-"));
    out = "";
    err = "";
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  describe("a forced write failure changes nothing", () => {
    // Without --force the report is put in place with `link`; with it, `rename`.
    const shared: Step[] = ["mkdir", "open", "partial write", "sync"];
    const cases = [
      ...shared.flatMap((step) => [
        { step, force: false },
        { step, force: true },
      ]),
      { step: "link" as const, force: false },
      { step: "rename" as const, force: true },
    ];

    it.each(cases)(
      "failure at $step (force: $force): clear error, exit 1, no temp file, existing report unchanged",
      async ({ step, force }) => {
        mkdirSync(reportsDir());
        writeFileSync(reportFile(), "# A real night's report that must survive\n");
        const before = sha256(reportFile());

        const code = await runReport([sample(), ...(force ? ["--force"] : [])], io(failingAt(step)));

        expect(code).toBe(1);
        expect(err).toContain("Could not write reports/2026-11-19.md: ");
        expect(err).toContain("No report was written, and any existing report is unchanged.");
        expect(out).toBe("");
        expect(sha256(reportFile())).toBe(before);
        expect(tempFiles()).toEqual([]);
      },
    );

    it.each([...shared, "link" as const])(
      "failure at %s with no existing report leaves no report and no temp file",
      async (step) => {
        const code = await runReport([sample()], io(failingAt(step)));

        expect(code).toBe(1);
        expect(err).toContain("Could not write reports/2026-11-19.md");
        expect(existsSync(reportFile())).toBe(false);
        expect(tempFiles()).toEqual([]);
      },
    );

    it("a real folder failure (reports is a file) exits 1 and leaves that file unchanged", async () => {
      writeFileSync(reportsDir(), "not a folder\n");
      const before = sha256(reportsDir());

      expect(await runReport([sample()], io())).toBe(1);
      expect(err).toContain("Could not write reports/2026-11-19.md");
      expect(err).toContain("No report was written, and any existing report is unchanged.");
      expect(sha256(reportsDir())).toBe(before);
      expect(err).not.toMatch(/\b([A-Z]{2,}): \1:/); // the error code is not repeated
    });
  });

  describe("a filesystem without hard links (exFAT, FAT32)", () => {
    const noHardLinks = (code: string): WriteFs => ({
      ...realFs,
      link: (async () => {
        throw fsError(code);
      }) as WriteFs["link"],
    });

    it.each(["ENOTSUP", "EOPNOTSUPP"])(
      "link failing with %s: says hard links are unsupported, exits 1, writes nothing",
      async (code) => {
        const result = await runReport([sample()], io(noHardLinks(code)));

        expect(result).toBe(1);
        expect(err).toContain(`does not support hard links (${code}), for example exFAT or FAT32.`);
        expect(err).toContain("No report was written, and any existing report is unchanged.");
        expect(out).toBe("");
        expect(existsSync(reportFile())).toBe(false);
        expect(tempFiles()).toEqual([]);
      },
    );

    it("link failing with EPERM: names both possible causes, does not suggest --force, writes nothing", async () => {
      // EPERM can also mean a permission or security restriction, so it must not
      // be presented as proof of an unsupported filesystem.
      const result = await runReport([sample()], io(noHardLinks("EPERM")));

      expect(result).toBe(1);
      expect(err).toContain("The system refused to create a hard link in reports/ (EPERM).");
      expect(err).toContain("or a permission or security restriction blocked it.");
      expect(err).not.toContain("does not support hard links (EPERM)");
      expect(err).not.toContain("--force");
      expect(err).toContain("No report was written, and any existing report is unchanged.");
      expect(out).toBe("");
      expect(existsSync(reportFile())).toBe(false);
      expect(tempFiles()).toEqual([]);
    });

    it("leaves an existing report unchanged", async () => {
      mkdirSync(reportsDir());
      writeFileSync(reportFile(), "# Keep me\n");
      const before = sha256(reportFile());

      expect(await runReport([sample()], io(noHardLinks("ENOTSUP")))).toBe(1);
      expect(sha256(reportFile())).toBe(before);
      expect(tempFiles()).toEqual([]);
    });

    it("does not blame hard links for other link errors", async () => {
      expect(await runReport([sample()], io(failingAt("link")))).toBe(1);
      expect(err).not.toContain("does not support hard links");
    });

    it("--force still works there, because it uses rename", async () => {
      expect(await runReport([sample(), "--force"], io(noHardLinks("ENOTSUP")))).toBe(0);
      expect(readFileSync(reportFile(), "utf8")).toBe(out);
      expect(tempFiles()).toEqual([]);
    });
  });

  describe("no gap between check and write", () => {
    it.each([2, 10])("%i simultaneous runs on the same date: exactly one writes, the rest refuse", async (runs) => {
      const results = await Promise.all(
        Array.from({ length: runs }, async () => {
          let runOut = "";
          let runErr = "";
          const code = await runReport([sample()], {
            cwd,
            out: (text) => void (runOut += text),
            err: (text) => void (runErr += text),
          });
          return { code, out: runOut, err: runErr };
        }),
      );

      const winners = results.filter((result) => result.code === 0);
      const refused = results.filter((result) => result.code === 1);
      expect(winners).toHaveLength(1);
      expect(refused).toHaveLength(runs - 1);
      for (const result of refused) {
        expect(result.err).toContain("reports/2026-11-19.md already exists, so it was not overwritten.");
      }
      expect(readFileSync(reportFile(), "utf8")).toBe(winners[0]?.out);
      expect(tempFiles()).toEqual([]);
    });
  });

  describe("--force replaces the report path itself", () => {
    it("replaces a symlink at the report path and leaves the symlink's target unchanged", async () => {
      const target = join(cwd, "somewhere-else.md");
      writeFileSync(target, "# Not a report. Must not be touched.\n");
      const targetBefore = sha256(target);
      mkdirSync(reportsDir());
      symlinkSync(target, reportFile());

      expect(await runReport([sample(), "--force"], io())).toBe(0);

      expect(lstatSync(reportFile()).isSymbolicLink()).toBe(false);
      expect(lstatSync(reportFile()).isFile()).toBe(true);
      expect(readFileSync(reportFile(), "utf8")).toBe(out);
      expect(sha256(target)).toBe(targetBefore);
      expect(err).toContain("Replaced reports/2026-11-19.md");
      expect(tempFiles()).toEqual([]);
    });

    it("replaces an existing report in place and leaves no temp file", async () => {
      mkdirSync(reportsDir());
      writeFileSync(reportFile(), "stale\n");

      expect(await runReport([sample(), "--force"], io())).toBe(0);
      expect(readFileSync(reportFile(), "utf8")).toBe(out);
      expect(tempFiles()).toEqual([]);
    });
  });

  describe("temp files", () => {
    it("live in the report's folder with a recognisable name", async () => {
      const seen: string[] = [];
      const spyFs: WriteFs = {
        ...realFs,
        open: (async (...args: Parameters<typeof realFs.open>) => {
          seen.push(String(args[0]));
          return realFs.open(...args);
        }) as WriteFs["open"],
      };

      await writeFileAtomically(reportFile(), "content\n", { overwrite: false }, spyFs);

      expect(seen).toHaveLength(1);
      const temp = seen[0] ?? "";
      expect(temp.startsWith(join(reportsDir(), ".2026-11-19.md.polson-tmp-"))).toBe(true);
      expect(existsSync(temp)).toBe(false);
      expect(readFileSync(reportFile(), "utf8")).toBe("content\n");
    });
  });
});
