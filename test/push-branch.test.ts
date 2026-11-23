// Tests .github/polson/push-branch.sh, the only way Polson's agents push. Real git,
// with a bare repository in a temp directory as "origin", so nothing touches the
// network. Since the builder may now run `git rm` and `git mv`, the script refuses
// any push whose changes against the default branch touch .github/ (added,
// modified, deleted or renamed), and names the paths.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const PUSH = resolve(import.meta.dirname, "../.github/polson/push-branch.sh");
const BRANCH = "29-replace-fixture";

describe("push-branch.sh", () => {
  let dir: string;
  let remote: string;
  let work: string;
  let env: NodeJS.ProcessEnv;

  /** Runs git in `cwd`, failing the test if git fails. */
  function git(cwd: string, ...args: string[]): string {
    const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout;
  }

  function write(path: string, content: string) {
    mkdirSync(join(work, path, ".."), { recursive: true });
    writeFileSync(join(work, path), content);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polson-push-"));
    remote = join(dir, "origin.git");
    work = join(dir, "work");
    env = {
      PATH: process.env.PATH,
      HOME: dir,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    };
    git(dir, "init", "--quiet", "--bare", "--initial-branch=main", remote);
    git(dir, "clone", "--quiet", remote, work);
    git(work, "checkout", "--quiet", "-b", "main");
    write(".github/polson/phase.sh", "echo phase\n");
    write(".github/workflows/ci.yml", "name: CI\n");
    write("src/a.ts", "export const a = 1;\n");
    write("src/old.ts", "export const old = 1;\n");
    write("fixtures/qodo/pr15-no-issues.md", "skipped review\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "base");
    git(work, "push", "--quiet", "origin", "main");
    git(work, "checkout", "--quiet", "-b", BRANCH);
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function commitAndPush(message: string) {
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", message);
    return spawnSync("bash", [PUSH, "29"], { cwd: work, env, encoding: "utf8" });
  }

  const pushed = () => git(work, "ls-remote", "--heads", remote, BRANCH).trim() !== "";

  describe("refuses any change under .github/", () => {
    it("a branch that deletes a .github file (git rm)", () => {
      git(work, "rm", "--quiet", ".github/polson/phase.sh");
      const r = commitAndPush("delete a workflow script");

      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("Refusing to push");
      expect(r.stderr).toContain(".github/polson/phase.sh");
      expect(pushed()).toBe(false);
    });

    it("a branch that renames a file into .github/ (git mv)", () => {
      git(work, "mv", "src/a.ts", ".github/polson/a.ts");
      const r = commitAndPush("move a file into .github");

      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(".github/polson/a.ts");
      expect(pushed()).toBe(false);
    });

    it("a branch that renames a file out of .github/", () => {
      git(work, "mv", ".github/workflows/ci.yml", "src/ci.yml");
      const r = commitAndPush("move a workflow out");

      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(".github/workflows/ci.yml");
      expect(pushed()).toBe(false);
    });

    it("a branch that modifies a .github file", () => {
      write(".github/workflows/ci.yml", "name: CI\non: push\n");
      const r = commitAndPush("edit a workflow");

      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(".github/workflows/ci.yml");
      expect(pushed()).toBe(false);
    });
  });

  describe("allows changes outside .github/", () => {
    it("a normal src, test and fixtures change, including git rm and git mv", () => {
      write("src/a.ts", "export const a = 2;\n");
      write("test/a.test.ts", "// test\n");
      git(work, "rm", "--quiet", "src/old.ts");
      git(work, "mv", "fixtures/qodo/pr15-no-issues.md", "fixtures/qodo/pr11-no-issues.md");
      const r = commitAndPush("replace the fixture");

      expect(r.status, r.stderr).toBe(0);
      expect(pushed()).toBe(true);
    });

    it("a .github change made on main after the branch started is not blamed on the branch", () => {
      // Someone else changes .github/ on main after the branch started.
      const other = join(dir, "other");
      git(dir, "clone", "--quiet", remote, other);
      writeFileSync(join(other, ".github/workflows/ci.yml"), "name: CI changed on main\n");
      git(other, "commit", "--quiet", "-am", "change ci on main");
      git(other, "push", "--quiet", "origin", "main");

      write("src/a.ts", "export const a = 3;\n");
      const r = commitAndPush("src only");

      expect(r.status, r.stderr).toBe(0);
      expect(pushed()).toBe(true);
    });
  });

  // Qodo on PR #33: the agents' Write tool can reach .git/, so a planted hook could
  // run arbitrary code (or push something else) during the helper's own git calls.
  it("never runs git hooks from the repository", () => {
    write("src/a.ts", "export const a = 5;\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "src only");
    // Planted after the commit, so only the helper's own git calls could run them.
    const marker = join(dir, "hook-ran");
    for (const hook of ["pre-push", "reference-transaction", "post-checkout"]) {
      writeFileSync(join(work, ".git", "hooks", hook), `#!/bin/sh\ntouch "${marker}"\n`);
      chmodSync(join(work, ".git", "hooks", hook), 0o755);
    }
    const r = spawnSync("bash", [PUSH, "29"], { cwd: work, env, encoding: "utf8" });

    expect(r.status, r.stderr).toBe(0);
    expect(pushed()).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses when it cannot read the default branch (rule 6: unknown is not allowed)", () => {
    write("src/a.ts", "export const a = 4;\n");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "src only");
    git(work, "remote", "set-url", "origin", join(dir, "missing.git"));
    const r = spawnSync("bash", [PUSH, "29"], { cwd: work, env, encoding: "utf8" });

    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("could not read the default branch");
  });
});
