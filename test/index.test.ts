/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { parse as parseYaml } from "yaml";
import { synthSnapshot } from "./util/synth";
import { getProject } from "./util/test-project";

test("synths with minimal options", () => {
  const snapshot = synthSnapshot(getProject());

  expect(snapshot).toMatchSnapshot();
});

test("build runs without telemetry", () => {
  const snapshot = synthSnapshot(getProject());

  expect(JSON.parse(snapshot[".projen/tasks.json"])).toHaveProperty(
    "env.CHECKPOINT_DISABLE",
    "1"
  );
});

test("build runs without crash reporting", () => {
  const snapshot = synthSnapshot(getProject());

  expect(JSON.parse(snapshot["cdktf.json"])).toHaveProperty(
    "sendCrashReports",
    false
  );
});

test("package metadata includes both legacy and new provider keys", () => {
  const snapshot = synthSnapshot(getProject());
  const packageJson = JSON.parse(snapshot["package.json"]);

  expect(packageJson).toHaveProperty("cdktf.provider");
  expect(packageJson).toHaveProperty("cdktn.provider");
  expect(packageJson.cdktf.provider).toEqual(packageJson.cdktn.provider);
});

test("synths with custom Github runners", () => {
  const snapshot = synthSnapshot(getProject({ useCustomGithubRunner: true }));

  expect(snapshot).toMatchSnapshot();
});

test("synths with an advanced version range syntax", () => {
  const snapshot = synthSnapshot(
    getProject({ cdktnVersion: ">=0.12.2 <0.14.0" })
  );

  expect(snapshot).toMatchSnapshot();
});

test("sets minMajorVersion to 1 by default so that breaking changes increast the major version", () => {
  const snapshot = synthSnapshot(getProject());

  expect(JSON.parse(snapshot[".projen/tasks.json"])).toHaveProperty(
    "tasks.release.env.MIN_MAJOR",
    "1"
  );
});

test("sets resolution for yargs", () => {
  const snapshot = synthSnapshot(getProject());

  const packageJson = JSON.parse(snapshot["package.json"]);
  // pnpm routes addPackageResolutions to pnpm.overrides rather than resolutions
  expect(packageJson).toHaveProperty("pnpm.overrides");
  expect(packageJson.pnpm.overrides).toHaveProperty("@types/yargs");
  expect(packageJson.pnpm.overrides["@types/yargs"]).toEqual("17.0.13");
});

test("README contains provided Namespace", () => {
  const snapshotWithVersion = synthSnapshot(
    getProject({ terraformProvider: "random@~> 3.1" })
  );

  const snapshotWithoutVersion = synthSnapshot(
    getProject({ terraformProvider: "random" })
  );

  expect(snapshotWithVersion["README.md"]).toEqual(
    expect.stringContaining(
      "- [Terraform random provider](https://registry.terraform.io/providers/hashicorp/random/3.1.0)"
    )
  );

  expect(snapshotWithoutVersion["README.md"]).toEqual(
    expect.stringContaining(
      "- [Terraform random provider](https://registry.terraform.io/providers/hashicorp/random/)"
    )
  );
});

test("golang release workflow has copyright headers", () => {
  const snapshot = synthSnapshot(getProject());
  const release = snapshot[".github/workflows/release.yml"];
  const releaseLines = release.split("\n");
  const releaseGoLineIndex = releaseLines.findIndex((line: string) =>
    line.includes("release_go")
  );

  expect(releaseGoLineIndex).toBeGreaterThan(0);

  expect(releaseLines.slice(releaseGoLineIndex + 1).join("\n")).toEqual(
    expect.stringContaining("hashicorp/setup-copywrite")
  );
});

test("has a custom workflow and README if the project is deprecated", () => {
  const snapshot = synthSnapshot(
    getProject({ isDeprecated: true, deprecationDate: "December 11, 2023" })
  );

  expect(snapshot).toMatchSnapshot();

  expect(JSON.parse(snapshot["package.json"])).toHaveProperty(
    "cdktn.isDeprecated",
    true
  );
  expect(JSON.parse(snapshot["package.json"])).toHaveProperty(
    "cdktf.isDeprecated",
    true
  );

  expect(snapshot["README.md"]).toEqual(
    expect.stringContaining(
      "The CDK Terrain Team made the decision to stop publishing new versions of"
    )
  );

  const release = snapshot[".github/workflows/release.yml"];
  expect(release).toEqual(
    expect.stringContaining(
      "Deprecate the package in package managers if needed"
    )
  );

  const releaseLines = release.split("\n");
  const releaseGoLineIndex = releaseLines.findIndex((line: string) =>
    line.includes("release_go")
  );
  expect(releaseLines.slice(releaseGoLineIndex + 1).join("\n")).toEqual(
    expect.stringContaining(
      "// Deprecated: The CDK Terrain Team is no longer publishing new versions of the prebuilt provider for random."
    )
  );
});

test("override licensee", () => {
  const snapshot = synthSnapshot(
    getProject({ creationYear: 2021, licensee: "Acme Corp" })
  );

  expect(snapshot.LICENSE).toEqual(
    expect.stringContaining("Copyright (c) 2021 Acme Corp")
  );
});

// TODO: Re-enable when Maven requested
test.skip("override maven org", () => {
  const snapshot = synthSnapshot(getProject({ mavenOrg: "gofer" }));

  expect(JSON.parse(snapshot["package.json"])).toHaveProperty(
    "jsii.targets.java.maven.groupId",
    "io.gofer"
  );
  expect(JSON.parse(snapshot["package.json"])).toHaveProperty(
    "jsii.targets.java.package",
    "io.gofer.providers.random_provider"
  );
});

// TODO: Re-enable when Maven requested
test.skip("override maven group id", () => {
  const snapshot = synthSnapshot(getProject({ mavenGroupId: "dev.gofer" }));

  expect(JSON.parse(snapshot["package.json"])).toHaveProperty(
    "jsii.targets.java.maven.groupId",
    "dev.gofer"
  );
  expect(JSON.parse(snapshot["package.json"])).toHaveProperty(
    "jsii.targets.java.package",
    "dev.gofer.providers.random_provider"
  );
});

test("synths with npm trusted publishing enabled", () => {
  const snapshot = synthSnapshot(getProject({ npmTrustedPublishing: true }));

  expect(snapshot).toMatchSnapshot();

  const release = snapshot[".github/workflows/release.yml"];
  // Trusted publishing should set id-token: write permission
  expect(release).toEqual(expect.stringContaining("id-token: write"));
  // Should not reference NPM_TOKEN in the release_npm job
  const releaseLines = release.split("\n");
  const npmJobStart = releaseLines.findIndex((line: string) =>
    line.includes("release_npm:")
  );
  const npmJobEnd = releaseLines.findIndex(
    (line: string, idx: number) => idx > npmJobStart && /^\s{2}\w/.test(line)
  );
  const npmJobSection = releaseLines
    .slice(npmJobStart, npmJobEnd > 0 ? npmJobEnd : undefined)
    .join("\n");
  expect(npmJobSection).not.toEqual(expect.stringContaining("NPM_TOKEN"));
  // Should use Node 24.x for trusted publishing
  expect(npmJobSection).toEqual(expect.stringContaining("24.x"));
});

test("npm trusted publishing is disabled by default", () => {
  const snapshot = synthSnapshot(getProject());

  const release = snapshot[".github/workflows/release.yml"];
  // Default should use NPM_TOKEN
  expect(release).toEqual(expect.stringContaining("NPM_TOKEN"));
});

const releaseJobSection = (release: string, jobName: string): string => {
  const lines = release.split("\n");
  const start = lines.findIndex((line: string) => line.includes(`${jobName}:`));
  const end = lines.findIndex(
    (line: string, idx: number) => idx > start && /^\s{2}\w/.test(line)
  );
  return lines.slice(start, end > 0 ? end : undefined).join("\n");
};

/** Split the release workflow into its individual job bodies, keyed by job id. */
const releaseJobs = (release: string): Record<string, string> => {
  const lines = release.split("\n");
  const jobsAt = lines.findIndex((line) => /^jobs:/.test(line));
  const starts: Array<[string, number]> = [];
  lines.forEach((line, idx) => {
    const match = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(line);
    if (idx > jobsAt && match) starts.push([match[1], idx]);
  });
  return Object.fromEntries(
    starts.map(([name, start], idx) => [
      name,
      lines
        .slice(start, idx + 1 < starts.length ? starts[idx + 1][1] : undefined)
        .join("\n"),
    ])
  );
};

// package:js only repacks the tarball the build job already produced; every
// other package:* target is a real jsii-pacmak transpile that actually allocates.
test("every workflow that runs pnpm also installs pnpm", () => {
  // The pnpm migration switched the hand-built workflows (provider-upgrade,
  // deprecate-packages) to `pnpm install` but did not add the "Setup pnpm"
  // step projen injects into the workflows it generates itself. Result: exit
  // 127 "pnpm: command not found" on every provider, every day, and it only
  // surfaced once the first scheduled run fired after rollout -- snapshot
  // tests never execute a workflow, so nothing caught it.
  // Both variants are required: provider-upgrade.yml is only generated when the
  // project is NOT deprecated, and the deprecate job only when it IS. Checking
  // one snapshot silently skips the other workflow.
  const variants = {
    active: synthSnapshot(getProject()),
    deprecated: synthSnapshot(
      getProject({ isDeprecated: true, deprecationDate: "December 11, 2023" })
    ),
  };

  const offenders: string[] = [];
  const seen: string[] = [];

  for (const [variant, snapshot] of Object.entries(variants)) {
    for (const file of Object.keys(snapshot).filter((f) =>
      f.startsWith(".github/workflows/")
    )) {
      const workflow = parseYaml(snapshot[file]) as {
        jobs?: Record<string, { steps?: { uses?: string; run?: string }[] }>;
      };

      for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
        const steps = job.steps ?? [];
        const firstPnpmRun = steps.findIndex((s) =>
          /\bpnpm\b/.test(s.run ?? "")
        );
        if (firstPnpmRun === -1) continue;

        seen.push(`${variant}:${file}:${jobId}`);

        // Scope the check to THIS job, and require the setup to come first.
        // A file-level check is not enough: in the deprecated variant,
        // release.yml already carries projen's own pnpm/action-setup in the
        // regular release job, which masked the deprecate job missing it
        // entirely -- the exact bug this test exists to catch.
        const setupBefore = steps
          .slice(0, firstPnpmRun)
          .some((s) => (s.uses ?? "").startsWith("pnpm/action-setup"));
        if (!setupBefore) offenders.push(`${variant}:${file}:${jobId}`);
      }
    }
  }

  // Guard the guard: if these jobs stop being generated the test would pass
  // vacuously, which is how the original bug slipped through twice.
  expect(seen).toEqual(
    expect.arrayContaining([
      "active:.github/workflows/provider-upgrade.yml:upgrade",
      "deprecated:.github/workflows/release.yml:deprecate",
    ])
  );
  expect(offenders).toEqual([]);
});

const HEAVY_PACKAGE_TASKS = [
  "package:python",
  "package:java",
  "package:dotnet",
  "package:go",
];

test("heap ceiling leaves headroom and is overridable per provider", () => {
  const heapOf = (snapshot: Record<string, any>) =>
    JSON.parse(snapshot[".projen/tasks.json"]).env.NODE_OPTIONS;

  // Hosted runners are 7GB. Custom runners advertise 32GB but only ~24GB is
  // usable -- Depot reserves 8GB for the RAM-disk-backed disk accelerator. Both
  // defaults must stay strictly under the memory a job can actually get: a
  // ceiling above that is what let jsii-pacmak get OOM-killed instead of
  // collecting, and it is why lowering 31744 -> 28672 (still >24GB) fixed
  // nothing (see #34).
  expect(
    heapOf(synthSnapshot(getProject({ useCustomGithubRunner: true })))
  ).toEqual("--max-old-space-size=20480");
  expect(
    heapOf(synthSnapshot(getProject({ useCustomGithubRunner: false })))
  ).toEqual("--max-old-space-size=6656");

  // A provider that still OOMs on the default can dial it down without
  // forcing every other provider off the shared default. 16384 is the value
  // datadog's package:go was verified passing at.
  expect(
    heapOf(
      synthSnapshot(
        getProject({ useCustomGithubRunner: true, nodeHeapSizeMb: 16384 })
      )
    )
  ).toEqual("--max-old-space-size=16384");

  // The override must apply on hosted runners too, not just custom ones.
  expect(
    heapOf(
      synthSnapshot(
        getProject({ useCustomGithubRunner: false, nodeHeapSizeMb: 4096 })
      )
    )
  ).toEqual("--max-old-space-size=4096");
});

test("rejects a heap override Node could not parse", () => {
  // Node validates --max-old-space-size before running any script, so a bad
  // value here would not fail at synth -- it would break every task in the
  // generated repo with an error pointing nowhere near this option. jsii
  // exposes `number` to Python/Go/Java/.NET, so non-integers are reachable
  // from those runtimes too, not just from a TypeScript typo.
  for (const bad of [1.5, 0, -1, NaN, Infinity]) {
    expect(() =>
      synthSnapshot(getProject({ nodeHeapSizeMb: bad }))
    ).toThrowError(/nodeHeapSizeMb must be a positive safe integer/);
  }

  // Boundary: the smallest legal value must still be accepted.
  expect(() =>
    synthSnapshot(getProject({ nodeHeapSizeMb: 1 }))
  ).not.toThrowError();
});

test("jobs forced onto hosted runners never run a heavy jsii-pacmak task", () => {
  const snapshot = synthSnapshot(
    getProject({
      useCustomGithubRunner: true,
      npmTrustedPublishing: true,
      pypiTrustedPublishing: true,
    })
  );

  // This ceiling is global to .projen/tasks.json, and projen's task runner
  // merges it as `{...process.env, ...taskEnv}` -- so it overrides any ambient,
  // job-level or step-level NODE_OPTIONS. A job we force onto a smaller
  // GitHub-hosted runner therefore inherits a heap ceiling well above that
  // runner's physical RAM, and V8 grows until the kernel OOM-kills it rather
  // than collecting. That is only tolerable for tasks that barely allocate.
  const tasks = JSON.parse(snapshot[".projen/tasks.json"]);
  expect(tasks.env.NODE_OPTIONS).toEqual("--max-old-space-size=20480");

  const jobs = releaseJobs(snapshot[".github/workflows/release.yml"]);
  const hosted = Object.entries(jobs).filter(([, body]) =>
    body.includes("runs-on: ubuntu-latest")
  );
  // npm OIDC is only supported on GitHub-hosted runners, so at least one job is
  // always pinned there. If this is ever empty the test has stopped testing.
  expect(hosted.map(([name]) => name)).toContain("release_npm");

  const offenders = hosted.flatMap(([name, body]) =>
    HEAVY_PACKAGE_TASKS.filter((task) => body.includes(task)).map(
      (task) => `${name} -> ${task}`
    )
  );
  expect(offenders).toEqual([]);
});

test("synths with pypi trusted publishing enabled", () => {
  const snapshot = synthSnapshot(
    getProject({ useCustomGithubRunner: true, pypiTrustedPublishing: true })
  );

  expect(snapshot).toMatchSnapshot();

  const release = snapshot[".github/workflows/release.yml"];
  const pypiJobSection = releaseJobSection(release, "release_pypi");
  // Trusted publishing should set id-token: write permission
  expect(pypiJobSection).toEqual(expect.stringContaining("id-token: write"));
  // Should not reference TWINE credentials in the release_pypi job
  expect(pypiJobSection).not.toEqual(expect.stringContaining("TWINE"));
  // PyPI does not restrict trusted publishing to GitHub-hosted runners, so the
  // job must stay on the custom runner. Moving it would strand package:python
  // (a real jsii-pacmak transpile) with the 28GB heap ceiling that
  // useCustomGithubRunner writes into .projen/tasks.json, on a smaller box.
  expect(pypiJobSection).toEqual(
    expect.stringContaining("runs-on: depot-ubuntu-24.04-8")
  );
  expect(pypiJobSection).not.toEqual(
    expect.stringContaining("runs-on: ubuntu-latest")
  );
});

test("pypi trusted publishing is disabled by default", () => {
  const snapshot = synthSnapshot(getProject());

  const release = snapshot[".github/workflows/release.yml"];
  // Default should use TWINE credentials
  const pypiJobSection = releaseJobSection(release, "release_pypi");
  expect(pypiJobSection).toEqual(expect.stringContaining("TWINE"));
});

test("pypi release stays on the custom runner when trusted publishing is off", () => {
  const snapshot = synthSnapshot(getProject({ useCustomGithubRunner: true }));

  const release = snapshot[".github/workflows/release.yml"];
  const pypiJobSection = releaseJobSection(release, "release_pypi");
  expect(pypiJobSection).toEqual(
    expect.stringContaining("depot-ubuntu-24.04-8")
  );
  expect(pypiJobSection).not.toEqual(expect.stringContaining("ubuntu-latest"));
});

test("deprecated project with trusted publishing uses NPM_TOKEN fallback for deprecation", () => {
  const snapshot = synthSnapshot(
    getProject({
      isDeprecated: true,
      deprecationDate: "December 11, 2023",
      npmTrustedPublishing: true,
    })
  );

  const release = snapshot[".github/workflows/release.yml"];
  // Deprecation step should still reference NPM_TOKEN (fallback)
  const releaseLines = release.split("\n");
  const deprecateJobStart = releaseLines.findIndex((line: string) =>
    line.includes("deprecate:")
  );
  const deprecateSection = releaseLines.slice(deprecateJobStart).join("\n");
  expect(deprecateSection).toEqual(expect.stringContaining("NPM_TOKEN"));
});

test("with minNodeVersion", () => {
  const snapshot = synthSnapshot(
    getProject({
      useCustomGithubRunner: false,
      terraformProvider: "vancluever/acme@~> 2.10",
      cdktnVersion: "^0.20.0",
      constructsVersion: "^10.3.0",
      minNodeVersion: "18.12.0",
      jsiiVersion: "~5.3.0",
      typescriptVersion: "~5.3.0", // NOTE: this should be the same major/minor version as JSII
      devDeps: ["@cdktn/provider-project@^0.5.0"],
      isDeprecated: false,
    })
  );

  expect(snapshot).toMatchSnapshot();
});

test("deprecated cdktfVersion option still works as alias for cdktnVersion", () => {
  const snapshot = synthSnapshot(
    getProject({ cdktfVersion: "0.21.0", cdktnVersion: undefined as any })
  );

  const packageJson = JSON.parse(snapshot["package.json"]);
  // Should use cdktn as peer dep (not cdktf), even when configured via the old option name
  expect(packageJson.peerDependencies).toHaveProperty("cdktn", "0.21.0");
  expect(packageJson.peerDependencies).not.toHaveProperty("cdktf");
  expect(packageJson.devDependencies).toHaveProperty("cdktn", "0.21.0");
  expect(packageJson.devDependencies).toHaveProperty("cdktn-cli", "0.21.0");
  expect(packageJson.devDependencies).not.toHaveProperty("cdktf");
  expect(packageJson.devDependencies).not.toHaveProperty("cdktf-cli");
});

test("first-party packages are exempt from the upgrade cooldown", () => {
  const snapshot = synthSnapshot(getProject());
  const workspace = parseYaml(snapshot["pnpm-workspace.yaml"]);

  // The cooldown reaches the upgrade task as a `pnpm update` flag; pnpm reads the
  // exclusion list from pnpm-workspace.yaml, so both halves have to line up or a
  // release of this template cannot reach provider repos for four days.
  expect(
    JSON.parse(snapshot[".projen/tasks.json"]).tasks.upgrade.steps
  ).toEqual(
    expect.arrayContaining([
      {
        execArgs: expect.arrayContaining([
          "pnpm",
          "update",
          "--config.minimum-release-age=5760",
        ]),
      },
    ])
  );
  expect(workspace.minimumReleaseAgeExclude).toEqual([
    "@cdktn/provider-project",
    "cdktn",
    "cdktn-cli",
  ]);

  // The waiver is first-party only -- everything else still waits out the cooldown.
  expect(workspace.minimumReleaseAgeExclude).not.toContain("projen");
  expect(workspace.minimumReleaseAgeExclude).not.toContain("constructs");
});

test("a failed upgrade run opens an issue instead of failing silently", () => {
  const snapshot = synthSnapshot(getProject());
  const upgradeJob = parseYaml(snapshot[".github/workflows/upgrade-main.yml"])
    .jobs.upgrade;

  // Weekly cadence is only tolerable if a failure is noticed -- otherwise one
  // silent break costs a week of dependency movement, as it did for awscc.
  expect(upgradeJob.permissions.issues).toBe("write");

  const failureStep = upgradeJob.steps.find(
    (step: { name?: string }) => step.name === "Create issue on failure"
  );
  expect(failureStep).toBeDefined();
  expect(failureStep.if).toContain("failure()");
  // Deduplicated on the label, so a persistent failure files one issue.
  expect(failureStep.run).toContain("gh issue list --label failed-upgrade");
  expect(failureStep.run).toContain("gh issue create");
});

test("the cooldown is moot for deprecated projects, which have no upgrade task", () => {
  const snapshot = synthSnapshot(getProject({ isDeprecated: true }));

  expect(JSON.parse(snapshot[".projen/tasks.json"]).tasks).not.toHaveProperty(
    "upgrade"
  );
});
