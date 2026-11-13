/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { spawnSync } from "child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { synthSnapshot } from "./util/synth";
import { getProject } from "./util/test-project";

/**
 * The "Create Issue" step is the only report a failed publish gets, and GitHub
 * runs it under `bash -e`: if anything in it can abort it before
 * `gh issue create`, a failed release is silent again. These run the real
 * generated step against a fake `gh` on PATH and assert on the calls it makes.
 */

function createIssueRun(): string {
  const jobs = parseYaml(
    synthSnapshot(getProject())[".github/workflows/release.yml"]
  ).jobs as Record<string, { steps: { name?: string; run?: string }[] }>;
  const run = jobs.release_golang.steps.find(
    (s) => s.name === "Create Issue"
  )?.run;
  if (!run) throw new Error("release_golang has no Create Issue step");
  return run;
}

/**
 * Runs the step with a fake `gh` that logs its arguments and exits with
 * `labelExit` for `gh label create`, and with `labelledIssueExit` for a
 * `gh issue create` that carries `--label`. An unlabelled issue always succeeds.
 */
function runStep(opts: { labelExit?: number; labelledIssueExit?: number }) {
  const dir = mkdtempSync(join(tmpdir(), "publish-failure-issue-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "gh-calls.txt");
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
        `if [ "$1 $2" = "label create" ]; then exit ${opts.labelExit ?? 0}; fi`,
        `if [ "$1 $2" = "issue create" ] && [[ " $* " == *" --label "* ]]; then exit ${
          opts.labelledIssueExit ?? 0
        }; fi`,
        "exit 0",
        "",
      ].join("\n")
    );
    chmodSync(join(bin, "gh"), 0o755);

    const res = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-e", "-c", createIssueRun()],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          VERSION: "1.2.3",
          RUN_URL: "https://example.invalid/run",
        },
      }
    );
    const calls = readFileSync(log, "utf8").trim().split("\n");
    return { status: res.status, stdout: res.stdout, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const issueCalls = (calls: string[]) =>
  calls.filter((c) => c.startsWith("issue create"));

test("opens the labelled issue when everything succeeds", () => {
  const { status, calls } = runStep({});

  expect(status).toBe(0);
  expect(calls[0]).toMatch(/^label create failed-release /);
  expect(issueCalls(calls)).toEqual([
    expect.stringContaining("--label failed-release"),
  ]);
});

test("a failed label create still opens the issue", () => {
  const { status, stdout, calls } = runStep({ labelExit: 1 });

  expect(status).toBe(0);
  expect(stdout).toContain(
    "::warning::Could not create the failed-release label"
  );
  expect(issueCalls(calls)).toEqual([
    expect.stringContaining("--label failed-release"),
  ]);
});

test("a rejected label still opens the issue, unlabelled", () => {
  const { status, calls } = runStep({ labelExit: 1, labelledIssueExit: 1 });

  expect(status).toBe(0);
  const issues = issueCalls(calls);
  expect(issues).toHaveLength(2);
  expect(issues[1]).not.toContain("--label");
  expect(issues[1]).toContain(
    "Publishing v1.2.3 to GitHub Go Module Repository failed"
  );
});
