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
  rmSync,
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

/** Options shared by fakePnpm, runScript and runIn -- one contract, no drift. */
interface FakeOpts {
  auditOutput: string;
  auditExit?: number;
  updateExit?: number;
  updateStderr?: string;
  /** Audit output for the post-update re-audit; defaults to a clean result. */
  auditOutputAfter?: string;
}

const SCRIPT = "scripts/upgrade-vulnerable-transitives.js";

/** A pnpm whose `audit` prints `auditOutput` and whose `update` records argv. */
function fakePnpm(dir: string, opts: FakeOpts) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const argsLog = join(dir, "update-args.txt");
  writeFileSync(
    join(bin, "pnpm"),
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "audit" ]; then',
      `  if [ -f ${JSON.stringify(join(dir, "audited"))} ]; then`,
      `    cat <<'JSON'\n${opts.auditOutputAfter ?? '{"advisories":{}}'}\nJSON`,
      "    exit 0",
      "  fi",
      `  touch ${JSON.stringify(join(dir, "audited"))}`,
      `  cat <<'JSON'\n${opts.auditOutput}\nJSON`,
      `  exit ${opts.auditExit ?? 1}`,
      "fi",
      `if [ "$1" = "update" ]; then`,
      `  printf '%s\\n' "$*" >> ${JSON.stringify(argsLog)}`,
      `  printf '%s' ${JSON.stringify(opts.updateStderr ?? "")} >&2`,
      `  exit ${opts.updateExit ?? 0}`,
      "fi",
      "exit 0",
      "",
    ].join("\n")
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  return { bin, argsLog };
}

function runScript(opts: FakeOpts) {
  const dir = mkdtempSync(join(tmpdir(), "transitives-"));
  try {
    return runIn(dir, opts);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runIn(dir: string, opts: FakeOpts) {
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

const advisory = (
  modules: string[],
  opts: { id?: string; version?: string } = {}
) =>
  JSON.stringify({
    advisories: Object.fromEntries(
      modules.map((m, i) => [
        String(i),
        {
          module_name: m,
          severity: "high",
          github_advisory_id: opts.id ?? `GHSA-fake-${m}`,
          findings: [
            { version: opts.version ?? "1.0.0", paths: [`.>parent>${m}`] },
          ],
        },
      ])
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
    updateStderr: "ERR_PNPM_NO_MATURE_MATCHING_VERSION undici",
  });

  // It still tried -- the tolerance is in how the failure is handled, not in
  // skipping the attempt.
  expect(updateArgs).toHaveLength(1);
});

test("a cooldown refusal is distinguishable from an unreadable audit", () => {
  const cooldown = runScript({
    auditOutput: advisory(["undici"]),
    updateExit: 1,
    updateStderr: "ERR_PNPM_NO_MATURE_MATCHING_VERSION undici",
  });
  const unreadable = runScript({ auditOutput: "not json at all" });

  expect(cooldown.stderr).toContain("no patch older than the cooldown");
  expect(cooldown.stderr).not.toContain("were NOT refreshed");
  expect(unreadable.stderr).toContain("were NOT refreshed");
  expect(unreadable.stderr).not.toContain("older than the cooldown");
});

test("an update failure that is not a cooldown refusal is not reported as one", () => {
  // Registry, auth and config failures throw from the same call. Calling all of
  // them "cooldown" would send whoever reads the annotation to the wrong place.
  const { stderr } = runScript({
    auditOutput: advisory(["undici"]),
    updateExit: 1,
    updateStderr:
      "ERR_PNPM_FETCH_401 Unauthorized GET https://registry.npmjs.org",
  });

  expect(stderr).toContain("::warning::");
  expect(stderr).not.toContain("cooldown");
  // and the pnpm output is echoed so the real cause is visible
  expect(stderr).toContain("ERR_PNPM_FETCH_401");
});

test("says so when the same advisory survives the upgrade", () => {
  // pnpm exits 0 having changed nothing whenever it has nowhere in range to move
  // to, which used to look identical to a fix. follow-redirects
  // GHSA-q3jh-wrc6-jgq8 sat on all 32 provider repos that way.
  const same = advisory(["follow-redirects"], {
    id: "GHSA-q3jh-wrc6-jgq8",
    version: "1.16.0",
  });
  const { stderr, updateArgs } = runScript({
    auditOutput: same,
    auditOutputAfter: same,
  });

  expect(updateArgs).toHaveLength(1);
  expect(stderr).toContain("::warning::still flagged after upgrading");
  // Correlated on advisory and installed version, not just the package name, and
  // the path is quoted so the reader can see which copy survived.
  expect(stderr).toContain("follow-redirects@1.16.0");
  expect(stderr).toContain("GHSA-q3jh-wrc6-jgq8");
  expect(stderr).toContain("via .>parent>follow-redirects");
});

test("does not guess why the upgrade failed to move it", () => {
  // The audit shows which advisory, version and path survived -- not whether a
  // stale published range, an override or a second installed copy is responsible.
  // Asserting a cause here previously pointed readers at the wrong remediation.
  const same = advisory(["follow-redirects"], { version: "1.16.0" });
  const { stderr } = runScript({ auditOutput: same, auditOutputAfter: same });

  expect(stderr).not.toContain("pins");
  expect(stderr).not.toContain("released");
  expect(stderr).toContain("inspect the advisory and dependency path");
});

test("a surviving advisory is distinguished from a different one on the same package", () => {
  // One advisory resolving while another appears for the same package is not the
  // same as "still stuck", and must not be reported as it.
  const { stderr } = runScript({
    auditOutput: advisory(["undici"], { id: "GHSA-old", version: "6.28.0" }),
    auditOutputAfter: advisory(["undici"], {
      id: "GHSA-new",
      version: "6.29.0",
    }),
  });

  expect(stderr).toContain("::warning::newly flagged after upgrading");
  expect(stderr).toContain("GHSA-new");
  expect(stderr).not.toContain("still flagged");
});

test("an unverifiable post-update audit is not reported as a failed refresh", () => {
  // "NOT refreshed" is true before the upgrade and false after it -- once the
  // update has run, an unreadable audit means the outcome is simply unknown.
  const { stderr } = runScript({
    auditOutput: advisory(["undici"]),
    auditOutputAfter: "not json at all",
  });

  expect(stderr).toContain("after upgrading");
  expect(stderr).toContain("unverified");
  expect(stderr).not.toContain("were NOT refreshed");
});

test("confirms resolution when the upgrade actually works", () => {
  const { stdout, stderr } = runScript({
    auditOutput: advisory(["undici"]),
    auditOutputAfter: JSON.stringify({ advisories: {} }),
  });

  expect(stdout).toContain("resolved: undici");
  expect(stderr).not.toContain("still flagged");
});

test("does not re-audit when the upgrade itself failed", () => {
  // The cooldown refusal already explains itself; a second audit would only add a
  // misleading "still flagged" on top of it.
  const { stderr } = runScript({
    auditOutput: advisory(["undici"]),
    updateExit: 1,
    updateStderr: "ERR_PNPM_NO_MATURE_MATCHING_VERSION undici",
    auditOutputAfter: advisory(["undici"]),
  });

  expect(stderr).toContain("no patch older than the cooldown");
  expect(stderr).not.toContain("still flagged");
});
