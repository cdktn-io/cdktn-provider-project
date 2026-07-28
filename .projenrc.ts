/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { cdk, github, JsonPatch } from "projen";
import {
  NodePackageManager,
  PnpmWorkspaceYamlSchemaNodeLinker,
  UpgradeDependenciesSchedule,
} from "projen/lib/javascript";
import { UpgradeJSIIAndTypeScript } from "./projenrc/upgrade-jsii-typescript";
import { UpgradeNode } from "./projenrc/upgrade-node";
import { AutoApprove } from "./src/auto-approve";
import { Automerge } from "./src/automerge";
import { CustomizedLicense } from "./src/customized-license";
import { LockIssues } from "./src/lock-issues";
import { generateRandomCron, Schedule } from "./src/util/random-cron";

// Remember that this is the list used by this repo (cdktn-provider-project) ONLY.
// If you want to update actions versions for the individual prebuilt providers,
// you will need to update the map in src/index.ts
const githubActionPinnedVersions = {
  "actions/checkout": "de0fac2e4500dabe0009e67214ff5f5447ce83dd", // v6.0.2
  "actions/download-artifact": "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", // v8.0.1
  "actions/github-script": "ed597411d8f924073f98dfc5c65a23a2325f34cd", // v8.0.0
  "actions/setup-node": "48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e", // v6.4.0
  "actions/stale": "b5d41d4e1d5dceea10e7104786b73624c18a190f", // v10.2.0
  "actions/upload-artifact": "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", // v7.0.1
  "amannn/action-semantic-pull-request":
    "48f256284bd46cdaab1048c3721360e808335d50", // v6.1.1
  "dessant/lock-threads": "7266a7ce5c1df01b1c6db85bf8cd86c737dadbe7", // v6.0.0
  "hashicorp/setup-copywrite": "32638da2d4e81d56a0764aa1547882fc4d209636", // v1.1.3
  "peter-evans/create-pull-request": "5f6978faf089d4d20b00c7766989d076bb2fc7f1", // v8.1.1
  "actions/create-github-app-token": "29824e69f54612133e76f7eaac726eef6c875baf", // v2.2.1
  // projen emits this unpinned as `pnpm/action-setup@v5` once packageManager is pnpm
  "pnpm/action-setup": "fc06bc1257f339d1d5d8b3a19a8cae5388b55320", // v5
};

/** JSII and TS should always use the same major/minor version range */
const typescriptVersion = "~5.9.0";
const project = new cdk.JsiiProject({
  name: "@cdktn/provider-project",
  author: "CDK Terrain Maintainers",
  authorAddress: "https://cdktn.io",
  repositoryUrl: "https://github.com/cdktn-io/cdktn-provider-project.git",
  authorOrganization: true,
  licensed: false, // we do supply our own license file with a custom header
  pullRequestTemplate: false,
  typescriptVersion,
  jsiiVersion: typescriptVersion,
  // NOTE: projen pins the dev copies of these peers to the *floor* of each range,
  // which is what jsii wants (JSII6) and is what CI then compiles against. Keep
  // the projen floor at the version the fleet resolves -- upgrade-main takes
  // latest, so a floor that lags means CI tests something no provider repo runs.
  peerDeps: ["projen@^0.101.20", "constructs@^10.5.0"],
  packageManager: NodePackageManager.PNPM,
  // pnpm's default isolated linker symlinks deps into node_modules/.pnpm/. jsii-pacmak
  // shells out to `npm pack`, which follows those symlinks and emits `..`-escaping
  // tarball paths that most extractors silently drop -- publishing tarballs with the
  // bundled deps' transitives missing. pnpm now errors outright
  // (ERR_PNPM_BUNDLED_DEPENDENCIES_WITHOUT_HOISTED) rather than corrupting quietly.
  // This must live in pnpm-workspace.yaml, NOT .npmrc: pnpm 11 moved settings out of
  // .npmrc and silently ignores node-linker there.
  pnpmOptions: {
    workspaceYamlOptions: {
      nodeLinker: PnpmWorkspaceYamlSchemaNodeLinker.HOISTED,
      auditConfig: {
        // GHSA-mh99-v99m-4gvg (brace-expansion DoS) declares a flat affected range
        // of "<=5.0.7", which naively matches the 1.x line. We resolve 1.1.16 -- the
        // newest 1.x there is -- via minimatch@3 under eslint and
        // commit-and-tag-version, so there is nothing to upgrade to. Forcing 5.0.8
        // would break minimatch@3, which requires ^1.1.7. Dev tooling only: it is not
        // in `deps`/`bundledDeps` and so never ships. Revisit when those pull a
        // minimatch that has moved off brace-expansion@1.
        ignoreGhsas: ["GHSA-mh99-v99m-4gvg"],
      },
    },
  },
  deps: ["change-case", "fs-extra"],
  bundledDeps: ["change-case", "fs-extra"],
  defaultReleaseBranch: "main",
  releaseToNpm: true,
  npmTrustedPublishing: true,
  minNodeVersion: "22.11.0",
  // Fails the build on any high/critical advisory. Combined with auto-merge requiring
  // green CI, a compromised upgrade PR cannot merge itself.
  auditDeps: true,
  auditDepsOptions: {
    level: "high",
    runOn: "build",
  },
  prettier: true,
  stale: false, // disabling for now but keeping the options below so we can turn it back on if desired
  staleOptions: {
    issues: {
      exemptLabels: ["backlog", "help wanted", "no-auto-close"],
      staleLabel: "stale",
      daysBeforeStale: 30,
      staleMessage:
        "Hi there! 👋 We haven't heard from you in 30 days and would like to know if the problem has been resolved or if " +
        "you still need help. If we don't hear from you before then, I'll auto-close this issue in 30 days.",
      daysBeforeClose: 30,
      closeMessage:
        "I'm closing this issue because we haven't heard back in 60 days. ⌛️ If you still need help, feel free to reopen the issue!",
    },
    pullRequest: {
      exemptLabels: ["backlog", "help wanted", "no-auto-close"],
      staleLabel: "stale",
      daysBeforeStale: 60,
      staleMessage:
        "Hi there! 👋 We haven't heard from you in 60 days and would like to know if you're still working on this or need help. " +
        "If we don't hear from you before then, I'll auto-close this PR in 30 days.",
      daysBeforeClose: 30,
      closeMessage:
        "I'm closing this pull request because we haven't heard back in 90 days. ⌛️ If you're still working on this, feel free to reopen the PR or create a new one!",
    },
  },
  depsUpgradeOptions: {
    // Skip versions published in the last 4 days, so a compromised release has time
    // to be flagged before an auto-merging upgrade PR pulls it in. Not supported on
    // yarn classic, which is part of why this project moved to pnpm.
    cooldown: 4,
    workflowOptions: {
      labels: ["automerge", "auto-approve", "dependencies"],
      schedule: UpgradeDependenciesSchedule.WEEKLY,
    },
  },
  workflowGitIdentity: {
    // TODO: Set up email for team-cdk-terrain
    name: "team-cdk-terrain",
    email: "github-team-cdk-terrain@cdktn.io",
  },
  projenrcTs: true,
  githubOptions: {
    projenCredentials: github.GithubCredentials.fromApp(),
    // projen >=0.100 moved the `mergify` project option under githubOptions
    mergify: false,
  },
});

project.addDevDeps(
  "glob",
  "@types/glob",
  "@types/fs-extra",
  "@action-validator/core",
  "@action-validator/cli",
  // Tests parse the generated workflow YAML so assertions can be job-scoped
  // rather than grepping whole files. It already resolves transitively via
  // projen, but relying on that trips import/no-extraneous-dependencies and
  // would break silently if projen ever dropped it.
  "yaml@^2.9.0"
);

project.addFields({ publishConfig: { access: "public" } });

// projen declares constructs as both a dependency and a peer at ^10.5.0. With the
// dev copy pinned to the 10.5.0 floor (as jsii requires), yarn would otherwise
// resolve projen's own ^10.5.0 to a newer release and nest a second copy, which
// jsii-pacmak rejects: "Conflicting versions of constructs in type system".
// Collapsing to one hoisted 10.5.0 satisfies projen's range and keeps what we
// compile against identical to the floor we promise consumers.
// NOTE: `resolutions` only affects installs *in this repo*; it is ignored for
// consumers of the published package, so it does not narrow their contract.
project.package.addPackageResolutions("constructs@10.5.0");

// projen >=0.100 removed the `scripts` project option; set it on the package directly
project.package.setScript("eslint:fix", "eslint . --ext .ts --fix");

// TODO: Keep original License and add new headers for Fork
new CustomizedLicense(project, 2020);
new LockIssues(project);
new AutoApprove(project);
new Automerge(project);
new UpgradeJSIIAndTypeScript(project, typescriptVersion);
new UpgradeNode(project);

project.addPackageIgnore("projenrc");
project.addPackageIgnore("/.projenrc.ts");
project.addPackageIgnore(".copywrite.hcl");

// Make sure 'chore' tasks also show up in the changelog
// Changes in this repo can be quite consequential, so don't hide chores
project.addFields({
  "standard-version": {
    types: [
      {
        type: "feat",
        section: "Features",
      },
      {
        type: "fix",
        section: "Bug Fixes",
      },
      {
        type: "chore",
        section: "Updates",
      },
      {
        type: "docs",
        hidden: true,
      },
      {
        type: "style",
        hidden: true,
      },
      {
        type: "refactor",
        hidden: true,
      },
      {
        type: "perf",
        hidden: true,
      },
      {
        type: "test",
        hidden: true,
      },
    ],
  },
});

const validateTask = project.addTask("validate-workflows", {
  exec: `find ./.github/workflows -type f -name "*.yml" -print0 | xargs -0 -n 1 npx action-validator`,
});
validateTask.description =
  "Lint the YAML files generated by Projen to define GitHub Actions and Workflows, checking them against published JSON schemas";
project.postCompileTask.spawn(validateTask);

// Run copywrite tool to add copyright headers to all files
// This is for this repository itself, not for the projects
// using this Projen template
project.buildWorkflow?.addPostBuildSteps(
  {
    name: "Setup Copywrite tool",
    uses: "hashicorp/setup-copywrite",
    with: { version: "v0.22.0" },
  },
  { name: "Add headers using Copywrite tool", run: "copywrite headers" }
);

// Use pinned versions of github actions
Object.entries(githubActionPinnedVersions).forEach(([name, sha]) => {
  project.github?.actions.set(name, `${name}@${sha}`);
});

const releaseWorkflow = project.tryFindObjectFile(
  ".github/workflows/release.yml"
);
releaseWorkflow?.addOverride("on.push", {
  branches: ["main"],
  "paths-ignore": [
    // don't do a release if the change was only to these files/directories
    ".github/ISSUE_TEMPLATE/**",
    ".github/CODEOWNERS",
    ".github/dependabot.yml",
    ".github/**/*.md",
  ],
});

// Trusted publishing requires npm >=11.5.1 which ships with Node 24
project.github
  ?.tryFindWorkflow("release")
  ?.file?.patch(
    JsonPatch.replace("/jobs/release_npm/steps/0/with/node-version", "24.x")
  );

const staleWorkflow = project.tryFindObjectFile(".github/workflows/stale.yml");
staleWorkflow?.addOverride("on.schedule", [
  {
    cron: generateRandomCron({ project, maxHour: 4, hourOffset: 1 }),
  },
]);

const upgradeWorkflow = project.tryFindObjectFile(
  ".github/workflows/upgrade-main.yml"
);
upgradeWorkflow?.addOverride("on.schedule", [
  {
    cron: generateRandomCron({
      project,
      maxHour: 0,
      schedule: Schedule.Weekly,
    }),
  },
]);

project.synth();
