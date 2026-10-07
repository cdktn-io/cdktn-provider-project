/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { spawnSync, SpawnSyncReturns } from "child_process";
import * as os from "os";
import * as path from "path";
import * as fs from "fs-extra";
import { synthSnapshot } from "./util/synth";
import { getProject } from "./util/test-project";

const SCRIPT_PATH = "scripts/apply-self-mutation-patch.js";

// The script shells out to git, so it can only be exercised where a POSIX
// shebang/exec shim works. CI is linux; skip elsewhere rather than fail.
const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

describeOnPosix(SCRIPT_PATH, () => {
  let workdir: string;
  let scriptFile: string;
  let repo: string;
  let fakeGitDir: string;

  /**
   * A patch whose content is hostile to naive chunking: latin-1 bytes that a
   * utf-8 round trip would destroy, CRLF line endings, and body lines that look
   * like the "diff --git " chunk boundary marker.
   */
  const hostileFileContent = (): Buffer =>
    Buffer.concat([
      Buffer.from("line one caf"),
      Buffer.from([0xe9]),
      Buffer.from("\r\n"),
      Buffer.from("+diff --git a/fake b/fake\n"),
      Buffer.from("diff --git a/not-really b/not-really\n"),
      Buffer.from("x".repeat(2000) + "\n"),
    ]);

  const FILE_COUNT = 40;
  const fileName = (i: number) => `f${String(i).padStart(3, "0")}.txt`;

  // Raw Buffer stdout on purpose: decoding `git diff` as utf-8 would turn the
  // fixture's latin-1 byte into U+FFFD and silently defeat the byte-exactness
  // assertions below.
  const git = (args: string[], cwd = repo): Buffer => {
    const res = spawnSync("git", args, { cwd });
    if (res.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
    }
    return res.stdout;
  };

  /** Run the script under test, optionally behind a git that fakes a size limit. */
  const run = (
    args: string[],
    env: Record<string, string> = {}
  ): SpawnSyncReturns<string> =>
    spawnSync(process.execPath, [scriptFile, ...args], {
      cwd: repo,
      encoding: "utf8",
      // The harness must not impose the very cap it is asserting about.
      maxBuffer: Infinity,
      env: {
        ...process.env,
        ...(Object.keys(env).some((k) => k.startsWith("FAKE_GIT_"))
          ? { PATH: `${fakeGitDir}${path.delimiter}${process.env.PATH}` }
          : {}),
        ...env,
      },
    });

  const resetRepo = () => {
    git(["reset", "--hard", "HEAD"]);
    git(["clean", "-fd"]);
  };

  beforeAll(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-patch-test-"));

    // The artifact under test is the generated script exactly as shipped.
    const snapshot = synthSnapshot(getProject());
    scriptFile = path.join(workdir, "apply-self-mutation-patch.js");
    fs.writeFileSync(scriptFile, snapshot[SCRIPT_PATH]);

    // A `git` shim that rejects oversized `git apply` input the way the real
    // git does past its ~1GiB limit, so the chunked path can be exercised
    // without a multi-GiB fixture.
    fakeGitDir = path.join(workdir, "fake-bin");
    fs.mkdirpSync(fakeGitDir);
    const realGit = spawnSync("which", ["git"], {
      encoding: "utf8",
    }).stdout.trim();
    const shim = path.join(fakeGitDir, "git");
    fs.writeFileSync(
      shim,
      [
        `#!${process.execPath}`,
        'const { spawnSync } = require("child_process");',
        'const fs = require("fs");',
        "const args = process.argv.slice(2);",
        'const isApply = args[0] === "apply" && Boolean(args[1]);',
        "if (isApply && process.env.FAKE_GIT_LOG) {",
        '  fs.appendFileSync(process.env.FAKE_GIT_LOG, args[1] + "\\n");',
        "}",
        "const limit = Number(process.env.FAKE_GIT_APPLY_LIMIT || 0);",
        "if (isApply && limit && fs.statSync(args[1]).size > limit) {",
        '  process.stderr.write("error: patch too large\\n");',
        "  process.exit(128);",
        "}",
        "// Flood stderr to prove the script does not cap it at Node's 1MiB",
        "// spawnSync default, which would SIGTERM git and lose its status.",
        "const flood = Number(process.env.FAKE_GIT_STDERR_BYTES || 0);",
        "if (isApply && flood) {",
        "  // writeSync, not stderr.write + process.exit: the latter would drop",
        "  // most of the buffer and the shim would under-deliver.",
        '  const out = Buffer.from("w".repeat(flood) + "\\n");',
        "  let off = 0;",
        "  while (off < out.length) { off += fs.writeSync(2, out, off); }",
        "  process.exit(0);",
        "}",
        `const res = spawnSync(${JSON.stringify(
          realGit
        )}, args, { stdio: "inherit" });`,
        "process.exit(res.status === null ? 1 : res.status);",
        "",
      ].join("\n"),
      { mode: 0o755 }
    );

    repo = path.join(workdir, "repo");
    fs.mkdirpSync(repo);
    git(["init", "-q", "."]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "test"]);
    // A global core.autocrlf would rewrite the CRLF fixture out from under us.
    git(["config", "core.autocrlf", "false"]);
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git(["add", "."]);
    git(["commit", "-qm", "init"]);

    for (let i = 0; i < FILE_COUNT; i++) {
      fs.writeFileSync(path.join(repo, fileName(i)), hostileFileContent());
    }
    git(["add", "-A"]);
    fs.writeFileSync(
      path.join(workdir, "big.patch"),
      git(["diff", "--staged"])
    );
    resetRepo();

    fs.writeFileSync(path.join(workdir, "empty.patch"), "");
    fs.writeFileSync(
      path.join(workdir, "corrupt.patch"),
      "diff --git a/x b/x\ngarbage\n"
    );
  });

  afterAll(() => fs.removeSync(workdir));

  beforeEach(() => resetRepo());

  const expectAllFilesApplied = () => {
    for (let i = 0; i < FILE_COUNT; i++) {
      expect(fs.readFileSync(path.join(repo, fileName(i)))).toEqual(
        hostileFileContent()
      );
    }
  };

  test("skips a missing patch file", () => {
    const res = run([path.join(workdir, "does-not-exist.patch")]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Empty patch. Skipping.");
  });

  test("skips an empty patch file", () => {
    const res = run([path.join(workdir, "empty.patch")]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Empty patch. Skipping.");
  });

  test("fails when no patch file is given", () => {
    const res = run([]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Usage:");
  });

  test("applies a patch that fits git's input limit", () => {
    const res = run([path.join(workdir, "big.patch")]);
    expect(res.status).toBe(0);
    expectAllFilesApplied();
  });

  // The bug this script exists to fix: `|| echo "Empty patch. Skipping."` made
  // a real failure look like an empty patch and let the job go green.
  test("fails loudly on a corrupt patch instead of reporting it empty", () => {
    const res = run([path.join(workdir, "corrupt.patch")]);
    expect(res.status).toBe(1);
    expect(res.stdout).not.toContain("Empty patch. Skipping.");
    // Assert that git's diagnostics came through, not their exact wording:
    // git 2.34 says "unrecognized input" where newer git says "No valid
    // patches in input". Matching only git's diagnostic prefix keeps the
    // property under test (git's reason is never swallowed) without pinning
    // the test to one git version's phrasing.
    expect(res.stderr).toMatch(/^(error|fatal):/m);
  });

  // Below the chunk limit the packer provably emits one chunk identical to the
  // input, so retrying it would only burn time on a multi-GB patch.
  test("does not fall back to chunking for a failure chunking cannot fix", () => {
    const res = run([path.join(workdir, "corrupt.patch")]);
    expect(res.status).toBe(1);
    expect(res.stdout).not.toContain("falling back to chunked apply");
    expect(res.stderr).toContain("chunking cannot help");
  });

  test("chunk-applies a patch that overruns git's input limit", () => {
    const patch = path.join(workdir, "big.patch");
    const res = run([patch], {
      FAKE_GIT_APPLY_LIMIT: "10000",
      APPLY_PATCH_CHUNK_MAX_BYTES: "5000",
    });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("falling back to chunked apply");
    expect(res.stdout).toMatch(/Applying \d+ chunk\(s\) sequentially/);
    // Byte-exact: latin-1 0xe9 and CRLF survive, and body lines that look like
    // the boundary marker did not split a file diff in half.
    expectAllFilesApplied();
  });

  // The chunks duplicate the whole patch (2.7GB for a provider like awscc), so
  // they must land on the volume that already holds it -- `${{ runner.temp }}`
  // -- rather than on whatever /tmp happens to be, and must not survive the run.
  test("writes chunks next to the patch and cleans them up", () => {
    const patchDir = path.join(workdir, "patch-dir");
    fs.mkdirpSync(patchDir);
    const patch = path.join(patchDir, "repo.patch");
    fs.copyFileSync(path.join(workdir, "big.patch"), patch);
    const log = path.join(workdir, "git-apply.log");
    fs.writeFileSync(log, "");

    const res = run([patch], {
      FAKE_GIT_APPLY_LIMIT: "10000",
      APPLY_PATCH_CHUNK_MAX_BYTES: "5000",
      FAKE_GIT_LOG: log,
    });
    expect(res.status).toBe(0);

    // First entry is the whole-patch attempt; the rest are the chunks.
    const applied = fs.readFileSync(log, "utf8").trim().split("\n");
    expect(applied[0]).toBe(patch);
    const chunks = applied.slice(1);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(path.dirname(path.dirname(chunk))).toBe(patchDir);
    }

    expect(fs.readdirSync(patchDir)).toEqual(["repo.patch"]);
  });

  // Node's spawnSync caps piped output at 1MiB by default, which SIGTERMs the
  // child and replaces its real exit status with ENOBUFS -- turning a
  // successful apply into a reported failure and truncating git's diagnostics.
  test("does not cap git's output at the 1MiB spawnSync default", () => {
    const res = run([path.join(workdir, "big.patch")], {
      FAKE_GIT_STDERR_BYTES: String(2 * 1024 * 1024),
    });

    expect(res.status).toBe(0);
    expect(res.stderr.length).toBeGreaterThan(2 * 1024 * 1024);
  });

  test("fails loudly when a chunk cannot be applied", () => {
    // Make one file in the middle of the patch conflict.
    fs.writeFileSync(path.join(repo, fileName(10)), "conflicting\n");

    const res = run([path.join(workdir, "big.patch")], {
      FAKE_GIT_APPLY_LIMIT: "10000",
      APPLY_PATCH_CHUNK_MAX_BYTES: "5000",
    });

    expect(res.status).toBe(1);
    expect(res.stdout).not.toContain("Empty patch. Skipping.");
    // Our own message plus evidence that git's reason reached the log, without
    // depending on how this git version words the conflict.
    expect(res.stderr).toContain("Failed to apply chunk");
    expect(res.stderr).toMatch(/^(error|fatal):/m);
  });
});
