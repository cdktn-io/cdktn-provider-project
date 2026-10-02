/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { execFileSync } from "child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  openSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { synthSnapshot } from "./util/synth";
import { getProject } from "./util/test-project";

/**
 * The script swallows parse and update failures on purpose, so a regression in
 * how it reads the audit or builds the `pnpm update` call would be silent -- the
 * synthesis tests would still pass while upgrade PRs quietly stopped resolving
 * advisories. These run the real generated script against a fake `pnpm` on PATH
 * and assert on the arguments it actually receives.
 */

const SCRIPT = "scripts/upgrade-vulnerable-transitives.js";

/** A pnpm whose `audit` prints `auditOutput` and whose `update` records argv. */
function fakePnpm(
  dir: string,
  opts: { auditOutput: string; auditExit?: number; updateExit?: number }
) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const argsLog = join(dir, "update-args.txt");
  writeFileSync(
    join(bin, "pnpm"),
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "audit" ]; then',
      `  cat <<'JSON'\n${opts.auditOutput}\nJSON`,
      `  exit ${opts.auditExit ?? 1}`,
      "fi",
      `if [ "$1" = "update" ]; then`,
      `  printf '%s\\n' "$*" >> ${JSON.stringify(argsLog)}`,
      `  exit ${opts.updateExit ?? 0}`,
      "fi",
      "exit 0",
      "",
    ].join("\n")
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  return { bin, argsLog };
}

function runScript(opts: {
  auditOutput: string;
  auditExit?: number;
  updateExit?: number;
}) {
  const dir = mkdtempSync(join(tmpdir(), "transitives-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, SCRIPT), synthSnapshot(getProject())[SCRIPT]);

  const { bin, argsLog } = fakePnpm(dir, opts);
  const stderrFile = join(dir, "stderr.txt");
  const stdout = execFileSync(process.execPath, [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    stdio: ["ignore", "pipe", openSync(stderrFile, "w")],
  });
  const stderr = readFileSync(stderrFile, "utf8");

  let updateArgs: string[] = [];
  try {
    updateArgs = readFileSync(argsLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    // no update-args.txt means `pnpm update` was never invoked
  }
  return { stdout, stderr, updateArgs };
}

const advisory = (modules: string[]) =>
  JSON.stringify({
    advisories: Object.fromEntries(
      modules.map((m, i) => [String(i), { module_name: m, severity: "high" }])
    ),
  });

test("names the flagged packages and passes depth and cooldown through", () => {
  const { stdout, updateArgs } = runScript({
    auditOutput: advisory(["undici"]),
  });

  expect(stdout).toContain("undici");
  // The exact invocation matters: without --depth Infinity pnpm silently leaves a
  // transitive package alone, and without the cooldown it would install anything.
  expect(updateArgs).toEqual([
    "update undici --depth Infinity --config.minimum-release-age=5760",
  ]);
});

test("deduplicates packages reported by more than one advisory", () => {
  // One package commonly carries several GHSAs; naming it twice is harmless but
  // the dedupe is what keeps the invocation predictable.
  const { updateArgs } = runScript({
    auditOutput: advisory(["undici", "js-yaml", "undici"]),
  });

  expect(updateArgs).toEqual([
    "update js-yaml undici --depth Infinity --config.minimum-release-age=5760",
  ]);
});

test("does not invoke an update when nothing is flagged", () => {
  const { stdout, updateArgs } = runScript({
    auditOutput: JSON.stringify({ advisories: {} }),
    auditExit: 0,
  });

  expect(stdout).toContain("no high+ advisories to resolve");
  expect(updateArgs).toEqual([]);
});

test("reports an unreadable audit instead of calling it a clean one", () => {
  // The dangerous failure is the quiet one: if a pnpm that changed its --json
  // shape read as "nothing flagged", upgrade PRs would silently stop refreshing
  // transitives. It must stay non-fatal, but it must not look clean.
  const { stdout, stderr, updateArgs } = runScript({
    auditOutput: "not json at all",
  });

  expect(stderr).toContain("::warning::");
  expect(stderr).toContain("were NOT refreshed");
  expect(stdout).not.toContain("no high+ advisories to resolve");
  expect(updateArgs).toEqual([]);
});

test("exits cleanly when the only patch is still inside the cooldown", () => {
  // pnpm raises ERR_PNPM_NO_MATURE_MATCHING_VERSION here. That is the cooldown
  // working, not a reason to lose every other bump in the same run.
  const { updateArgs } = runScript({
    auditOutput: advisory(["undici"]),
    updateExit: 1,
  });

  // It still tried -- the tolerance is in how the failure is handled, not in
  // skipping the attempt.
  expect(updateArgs).toHaveLength(1);
});

test("a cooldown refusal is distinguishable from an unreadable audit", () => {
  const cooldown = runScript({
    auditOutput: advisory(["undici"]),
    updateExit: 1,
  });
  const unreadable = runScript({ auditOutput: "not json at all" });

  expect(cooldown.stderr).toContain("within the cooldown");
  expect(cooldown.stderr).not.toContain("were NOT refreshed");
  expect(unreadable.stderr).toContain("were NOT refreshed");
  expect(unreadable.stderr).not.toContain("within the cooldown");
});
