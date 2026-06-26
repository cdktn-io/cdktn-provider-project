/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { cdk, github, JsonPatch } from "projen";
import { UpgradeDependenciesSchedule } from "projen/lib/javascript";
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
  peerDeps: ["projen@^0.99.0", "constructs@^10.4.2"],
  deps: ["change-case", "fs-extra"],
  bundledDeps: ["change-case", "fs-extra"],
  defaultReleaseBranch: "main",
  releaseToNpm: true,
  npmTrustedPublishing: true,
  minNodeVersion: "22.11.0",
  mergify: false,
  prettier: true,
  scripts: {
    "eslint:fix": "eslint . --ext .ts --fix",
  },
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
  },
});

project.addDevDeps(
  "glob",
  "@types/glob",
  "@types/fs-extra",
  "@action-validator/core",
  "@action-validator/cli"
);

project.addFields({ publishConfig: { access: "public" } });

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
