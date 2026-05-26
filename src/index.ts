/* eslint-disable @typescript-eslint/no-require-imports */
import assert = require("assert");
import { pascalCase } from "change-case";
import { ObjectFile, TextFile, cdk, github, JsonPatch } from "projen";
import { JobStep } from "projen/lib/github/workflows-model";
import { UpgradeDependenciesSchedule } from "projen/lib/javascript";
import { AlertOpenPrs } from "./alert-open-prs";
import { AutoApprove } from "./auto-approve";
import { AutoCloseCommunityIssues } from "./auto-close-community-issues";
import { Automerge } from "./automerge";
import { CdktfConfig } from "./cdktf-config";
import { CopyrightHeaders } from "./copyright-headers";
import { CustomizedLicense } from "./customized-license";
import { Dependabot } from "./dependabot";
import { DeprecatePackages } from "./deprecate-packages";
import { ForceRelease } from "./force-release";
import { GithubIssues } from "./github-issues";
import { LockIssues } from "./lock-issues";
import { PackageInfo } from "./package-info";
import { ProviderUpgrade } from "./provider-upgrade";
import { CheckForUpgradesScriptFile } from "./scripts/check-for-upgrades";
import { ShouldReleaseScriptFile } from "./scripts/should-release";
import { generateRandomCron, Schedule } from "./util/random-cron";

// ensure new projects start with 1.0.0 so that every following breaking change leads to an increased major version
const MIN_MAJOR_VERSION = 1;

export interface CdktnProviderProjectOptions extends cdk.JsiiProjectOptions {
  readonly useCustomGithubRunner?: boolean;
  readonly terraformProvider: string;
  readonly cdktnVersion: string;
  /**
   * @deprecated Use `cdktnVersion` instead. This alias is provided for backward compatibility.
   */
  readonly cdktfVersion?: string;
  readonly constructsVersion: string;
  readonly forceMajorVersion?: number;
  /**
   * defaults to "cdktn"
   */
  readonly namespace?: string;
  /**
   * defaults to "cdktn-io"
   * previously was "cdktf". Used for GitHub org name and package scoping
   */
  readonly githubNamespace?: string;
  /**
   * defaults to "Io.Cdktn"
   */
  readonly nugetOrg?: string;
  /**
   * defaults to "cdktn"
   */
  readonly mavenOrg?: string;
  /**
   * defaults to "io.${mavenOrg}"
   */
  readonly mavenGroupId?: string;
  /**
   * The year of the creation of the repository, for copyright purposes.
   * Will fall back to the current year if not specified.
   */
  readonly creationYear?: number;
  /**
   * Whether or not this prebuilt provider is deprecated.
   * If true, no new versions will be published.
   */
  readonly isDeprecated?: boolean;
  /**
   * An optional date when the project should be considered deprecated, to be used in the README text.
   * If no date is provided, then the date of the build will be used by default.
   */
  readonly deprecationDate?: string;
  /**
   * defaults to "HashiCorp, Inc."
   */
  readonly licensee?: string;
}

const getMavenName = (providerName: string): string => {
  return ["null", "random"].includes(providerName)
    ? `${providerName}_provider`
    : providerName.replace(/-/gi, "_");
};

const githubActionPinnedVersions = {
  "actions/checkout": "de0fac2e4500dabe0009e67214ff5f5447ce83dd", // v6.0.2
  "actions/download-artifact": "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", // v8.0.1
  "actions/github-script": "ed597411d8f924073f98dfc5c65a23a2325f34cd", // v8.0.0
  "actions/setup-dotnet": "c2fa09f4bde5ebb9d1777cf28262a3eb3db3ced7", // v5.2.0
  "actions/setup-go": "4a3601121dd01d1626a1e23e37211e3254c1c06c", // v6.4.0
  "actions/setup-java": "be666c2fcd27ec809703dec50e508c2fdc7f6654", // v5.2.0
  "actions/setup-node": "48b55a011bda9f5d6aeb4c2d9c7362e8dae4041", // v6.4.0
  "actions/setup-python": "a309ff8b426b58ec0e2a45f0f869d46889d02405", // v6.2.0
  "actions/stale": "b5d41d4e1d5dceea10e7104786b73624c18a190f", // v10.2.0
  "actions/upload-artifact": "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", // v7.0.1
  "amannn/action-semantic-pull-request":
    "48f256284bd46cdaab1048c3721360e808335d50", // v6.1.1
  "dessant/lock-threads": "7266a7ce5c1df01b1c6db85bf8cd86c737dadbe7", // v6.0.0
  "hashicorp/setup-copywrite": "32638da2d4e81d56a0764aa1547882fc4d209636", // v1.1.3
  "hashicorp/setup-terraform": "5e8dbf3c6d9deaf4193ca7a8fb23f2ac83bb6c85", // v4.0.0
  "imjohnbo/issue-bot": "3188c6ce06249206709d3b1f274d0d4c5a521601", // v3.4.4
  "peter-evans/create-pull-request": "5f6978faf089d4d20b00c7766989d076bb2fc7f1", // v8.1.1
  "slackapi/slack-github-action": "45a88b9581bfab2566dc881e2cd66d334e621e2c", // v3.0.3
  "actions/create-github-app-token": "29824e69f54612133e76f7eaac726eef6c875baf", // v2.2.1
};

export class CdktnProviderProject extends cdk.JsiiProject {
  constructor(options: CdktnProviderProjectOptions) {
    const cdktnVersion = options.cdktnVersion ?? options.cdktfVersion;
    assert(
      cdktnVersion,
      "Either cdktnVersion or cdktfVersion must be provided"
    );

    const {
      terraformProvider,
      workflowContainerImage,
      constructsVersion,
      minNodeVersion,
      jsiiVersion,
      typescriptVersion,
      isDeprecated,
      deprecationDate,
      // TODO: Confirm default Author Name
      authorName = "CDK Terrain Maintainers",
      authorAddress = "https://cdktn.io",
      namespace = "cdktn",
      githubNamespace = "cdktn-io",
      nugetOrg = "Io.Cdktn",
      mavenOrg = "cdktn",
      npmTrustedPublishing,
    } = options;

    const [fqproviderName, providerVersion] = terraformProvider.split("@");
    const providerName = fqproviderName.split("/").pop();
    assert(providerName, `${terraformProvider} doesn't seem to be valid`);
    assert(
      !providerName.endsWith("-go"),
      "providerName may not end with '-go' as this can conflict with repos for go packages"
    );

    const nugetName = `${nugetOrg}.Providers.${pascalCase(providerName)}`;
    const mavenGroupId = options.mavenGroupId ?? `io.${mavenOrg}`;
    const mavenName = `${mavenGroupId}.providers.${getMavenName(providerName)}`;
    const repository = `${githubNamespace}/${namespace}-provider-${providerName.replace(
      /-/g,
      ""
    )}`;
    const repositoryUrl = `github.com/${repository}`;

    const packageInfo: PackageInfo = {
      npm: {
        name: `@${namespace}/provider-${providerName}`,
      },
      python: {
        // distName: `${githubNamespace}-${namespace}-provider-${providerName.replace(
        distName: `${namespace}-provider-${providerName.replace(/-/gi, "_")}`,
        // module: `${githubNamespace}_${namespace}_provider_${providerName.replace(
        module: `${namespace}_provider_${providerName.replace(/-/gi, "_")}`,
      },
      publishToNuget: {
        dotNetNamespace: nugetName,
        packageId: nugetName,
      },
      publishToMaven: {
        javaPackage: mavenName,
        mavenGroupId: mavenGroupId,
        mavenArtifactId: `${namespace}-provider-${providerName}`,
      },
      publishToGo: {
        moduleName: `${repositoryUrl}-go`,
        gitUserEmail: "github-team-cdk-terrain@cdktn.io",
        gitUserName: "team-cdk-terrain",
        packageName: providerName.replace(/-/g, ""),
        // In order to use the copywrite action, we need to rebuild the full pre-publish steps workflow unfortunately
        // If someone knows a better way to do this mutation with minimal custom code, please do so
        prePublishSteps: [
          {
            name: "Checkout",
            uses: "actions/checkout",
            with: {
              path: ".repo",
            },
          },
          {
            name: "Install Dependencies",
            run: "cd .repo && yarn install --check-files --frozen-lockfile",
          },
          {
            name: "Extract build artifact",
            run: "tar --strip-components=1 -xzvf dist/js/*.tgz -C .repo",
          },
          {
            name: "Move build artifact out of the way",
            run: "mv dist dist.old",
          },
          {
            name: "Create go artifact",
            run: "cd .repo && npx projen package:go",
          },
          {
            name: "Setup Copywrite tool",
            uses: "hashicorp/setup-copywrite",
          },
          {
            name: "Copy copywrite hcl file",
            run: "cp .repo/.copywrite.hcl .repo/dist/go/.copywrite.hcl",
          },
          {
            name: "Add headers using Copywrite tool",
            run: "cd .repo/dist/go && copywrite headers",
          },
          {
            name: "Remove copywrite hcl file",
            run: "rm -f .repo/dist/go/.copywrite.hcl",
          },
          {
            name: "Remove some text from the README that doesn't apply to Go",
            run: [
              "sed -i 's/# CDKTN prebuilt bindings for/# CDKTN Go bindings for/' .repo/dist/go/*/README.md",
              // @see https://stackoverflow.com/a/49511949
              // eslint-disable-next-line prettier/prettier
              // prettier-ignore
              `sed -i -e '/## ${isDeprecated ? "Deprecated" : "Available"} Packages/,/### Go/!b' -e '/### Go/!d;p; s/### Go/## Go Package/' -e 'd' .repo/dist/go/*/README.md`,
              // sed -e is black magic and for whatever reason the string replace doesn't work so let's try it again:
              // eslint-disable-next-line prettier/prettier
              // prettier-ignore
              `sed -i 's/### Go/## ${isDeprecated ? "Deprecated" : "Go"} Package/' .repo/dist/go/*/README.md`,
              // Just straight up delete these full lines and everything in between them:
              "sed -i -e '/API.typescript.md/,/You can also visit a hosted version/!b' -e 'd' .repo/dist/go/*/README.md",
              `sed -i 's|Find auto-generated docs for this provider here:|Find auto-generated docs for this provider [here](https://${repositoryUrl}/blob/main/docs/API.go.md).|' .repo/dist/go/*/README.md`,
              // Just straight up delete these full lines and everything in between them:
              "sed -i -e '/### Provider Version/,/The provider version can be adjusted/!b' -e 'd' .repo/dist/go/*/README.md",
            ].join("\n"),
          },
          {
            name: "Copy the README file to the parent directory",
            run: "cp .repo/dist/go/*/README.md .repo/dist/go/README.md",
          },
          {
            name: "Collect go Artifact",
            run: "mv .repo/dist dist",
          },
        ],
      },
    };

    const workflowRunsOn = options.useCustomGithubRunner
      ? ["depot-ubuntu-24.04-8"] // 8 core, 32 GB
      : ["ubuntu-latest"]; // 7 GB

    super({
      ...options,
      authorAddress,
      authorName,
      minNodeVersion,
      workflowContainerImage,
      workflowRunsOn,
      licensed: false, // we do supply our own license file with a custom header
      releaseToNpm: true,
      npmTrustedPublishing: npmTrustedPublishing ?? false,
      name: packageInfo.npm.name,
      description: `Prebuilt ${providerName} Provider for CDK Terrain (cdktn)`,
      keywords: [
        "cdktn",
        "cdk-terrain",
        "cdktf",
        "terraform",
        "opentofu",
        "cdk",
        "provider",
        providerName,
      ],
      sampleCode: false,
      jest: false,
      authorOrganization: true,
      defaultReleaseBranch: "main",
      repository: `https://github.com/${repository}.git`,
      mergify: false,
      eslint: false,
      depsUpgrade: !isDeprecated,
      depsUpgradeOptions: {
        workflowOptions: {
          labels: ["automerge", "auto-approve", "dependencies"],
          schedule: UpgradeDependenciesSchedule.WEEKLY,
        },
      },
      python: packageInfo.python,
      publishToNuget: packageInfo.publishToNuget,
      publishToMaven: packageInfo.publishToMaven,
      publishToGo: packageInfo.publishToGo,
      releaseFailureIssue: true,
      peerDependencyOptions: {
        pinnedDevDependency: false,
      },
      workflowGitIdentity: {
        name: "team-cdk-terrain",
        email: "github-team-cdk-terrain@cdktn.io",
      },
      minMajorVersion: MIN_MAJOR_VERSION,
      stale: true,
      staleOptions: {
        issues: {
          staleLabel: "stale",
          daysBeforeStale: 45,
          staleMessage:
            "45 days have passed since this issue was opened, and I assume other publishes have succeeded in the meantime. " +
            "If no one removes the `stale` label or comments, I'm going to auto-close this issue in 14 days.",
          daysBeforeClose: 14,
          closeMessage:
            "2 months have passed, so I'm closing this issue with the assumption that other publishes have succeeded in the meantime.",
        },
        pullRequest: {
          staleLabel: "stale",
          daysBeforeStale: 1,
          staleMessage: `Closing this PR, if it has not merged there is most likely a CI or CDKTN issue preventing it from merging. If this has been a manual PR, please reopen it and add the \`no-auto-close\` label to prevent this from happening again.`,
          daysBeforeClose: 0,
          exemptLabels: ["no-auto-close"],
        },
      },
      pullRequestTemplate: false,
      docgen: false,
      githubOptions: {
        projenCredentials: github.GithubCredentials.fromApp(),
      },
    });

    this.addDevDeps(
      "dot-prop@^5.2.0",
      "@actions/core@^1.1.0",
      "@action-validator/core",
      "@action-validator/cli"
    );

    // Default memory is 7GB: https://docs.github.com/en/actions/using-github-hosted-runners/about-github-hosted-runners#supported-runners-and-hardware-resources
    // Custom Runners we use have 32GB of memory
    // The below numbers set heap limits that are ~1gb and ~0.5gb less, respectively, than the total available memory
    const maxOldSpaceSize = options.useCustomGithubRunner ? "31744" : "6656";

    // Golang needs more memory to build
    this.tasks.addEnvironment(
      "NODE_OPTIONS",
      `--max-old-space-size=${maxOldSpaceSize}`
    );

    this.tasks.addEnvironment("CHECKPOINT_DISABLE", "1");

    const validateTask = this.addTask("validate-workflows", {
      exec: `find ./.github/workflows -type f -name "*.yml" -print0 | xargs -0 -n 1 npx action-validator`,
    });
    validateTask.description =
      "Lint the YAML files generated by Projen to define GitHub Actions and Workflows, checking them against published JSON schemas";
    this.postCompileTask.spawn(validateTask);

    this.package.addPackageResolutions("@types/yargs@17.0.13");

    const setSafeDirectory = {
      name: "Set git config safe.directory",
      run: "git config --global --add safe.directory $(pwd)",
    };

    ((this.buildWorkflow as any).preBuildSteps as JobStep[]).push(
      setSafeDirectory
    );
    (this.release as any).defaultBranch.workflow.jobs.release.steps.splice(
      1,
      0,
      setSafeDirectory
    );

    // always publish a new GitHub release, even when publishing to a particular package manager fails
    const releaseWorkflow = this.tryFindObjectFile(
      ".github/workflows/release.yml"
    );
    releaseWorkflow?.addOverride("jobs.release_github.needs", "release");

    // Trusted publishing requires npm >=11.5.1 which ships with Node 24
    if (npmTrustedPublishing) {
      this.github
        ?.tryFindWorkflow("release")
        ?.file?.patch(
          JsonPatch.replace(
            "/jobs/release_npm/steps/0/with/node-version",
            "24.x"
          )
        );
    }

    // ensure we don't fail if the release file is not present
    const checkExistingTagStep = (
      this.release as any
    ).defaultBranch.workflow.jobs.release.steps.find(
      (s: object) => "id" in s && s.id === "check_tag_exists"
    );
    const oldExistingTagRun: string = checkExistingTagStep.run;
    prettyAssertEqual(
      oldExistingTagRun.split("\n")[0],
      "TAG=$(cat dist/releasetag.txt)",
      "release step changed, please check if the workaround still works!"
    );
    checkExistingTagStep.run = `if [ ! -f dist/releasetag.txt ]; then (echo "exists=true" >> $GITHUB_OUTPUT) && exit 0; fi\n${oldExistingTagRun}`;

    if (!isDeprecated) {
      const { upgrade, pr } = (this.upgradeWorkflow as any).workflows[0].jobs;
      upgrade.steps.splice(1, 0, setSafeDirectory);
      pr.steps.splice(1, 0, setSafeDirectory);
    }

    // release: Go — patch the release workflow's Go publish to use a GitHub
    // App installation token. The same patch is applied to force-release.yml
    // further below (after ForceRelease has constructed it), since
    // ForceRelease renders publish jobs from a fresh source and bypasses this
    // patch.
    const patchGoPublishToUseAppToken = (workflowFile?: ObjectFile) => {
      if (!workflowFile) return;
      const goPublishToken = github.GithubCredentials.fromApp({
        appIdSecret: "PROJEN_APP_ID",
        privateKeySecret: "PROJEN_APP_PRIVATE_KEY",
        owner: "${{ github.repository_owner }}",
        repositories: [
          packageInfo.publishToGo?.moduleName?.split("/").pop() ?? "",
        ],
        permissions: { contents: github.workflows.AppPermission.WRITE },
      });
      workflowFile.patch(
        JsonPatch.add(
          "/jobs/release_golang/steps/16",
          goPublishToken.setupSteps[0]
        ),
        JsonPatch.add(
          "/jobs/release_golang/steps/17/env/GITHUB_TOKEN",
          // GitHub App installation tokens (ghs_*) require the `x-access-token`
          // username when used in HTTPS git URLs. publib renders this env var
          // verbatim into `https://${GITHUB_TOKEN}@github.com/...`, so without
          // the prefix the push 401s and falls back to a TTY password prompt.
          `x-access-token:${goPublishToken.tokenRef}`
        )
      );
    };

    if (!isDeprecated) {
      patchGoPublishToUseAppToken(releaseWorkflow);
    }

    // Fix maven issue (https://github.com/cdklabs/publib/pull/777)
    github.GitHub.of(this)?.tryFindWorkflow("release")?.file?.patch(
      JsonPatch.add(
        "/jobs/release_maven/steps/10/env/MAVEN_OPTS",
        // See https://stackoverflow.com/questions/70153962/nexus-staging-maven-plugin-maven-deploy-failed-an-api-incompatibility-was-enco
        "--add-opens=java.base/java.util=ALL-UNNAMED --add-opens=java.base/java.lang.reflect=ALL-UNNAMED --add-opens=java.base/java.text=ALL-UNNAMED --add-opens=java.desktop/java.awt.font=ALL-UNNAMED"
      ),
      JsonPatch.remove(
        // This is no longer used.
        "/jobs/release_maven/steps/10/env/MAVEN_STAGING_PROFILE_ID"
      )
    );

    this.pinGithubActionVersions(githubActionPinnedVersions);

    new CdktfConfig(this, {
      terraformProvider,
      providerName,
      fqproviderName,
      providerVersion,
      cdktnVersion,
      constructsVersion,
      jsiiVersion,
      typescriptVersion,
      packageInfo,
      githubNamespace,
      deprecationDate,
      isDeprecated: !!isDeprecated,
    });
    new CustomizedLicense(this, options.creationYear, options.licensee);
    new GithubIssues(this, { providerName });
    new AutoApprove(this);
    new AutoCloseCommunityIssues(this, { providerName });
    new Automerge(this);
    new LockIssues(this);

    if (!isDeprecated) {
      const upgradeScript = new CheckForUpgradesScriptFile(this, {
        providerVersion,
        fqproviderName,
      });
      new ProviderUpgrade(this, {
        checkForUpgradesScriptPath: upgradeScript.path,
        workflowRunsOn,
        nodeHeapSize: maxOldSpaceSize,
      });
      new AlertOpenPrs(this, {
        slackWebhookUrl: "${{ secrets.ALERT_PRS_SLACK_WEBHOOK_URL }}",
        repository,
      });
      new Dependabot(this);
    }

    new TextFile(this, ".github/CODEOWNERS", {
      lines: [
        "# These owners will be the default owners for everything in ",
        "# the repo. Unless a later match takes precedence, ",
        "# they will be requested for review when someone opens a ",
        "# pull request.",
        "*       @cdktn-io/team-cdk-terrain",
      ],
    });

    if (!isDeprecated) {
      new ShouldReleaseScriptFile(this, {});

      const releaseTask = this.tasks.tryFind("release")!;
      this.removeTask("release");
      this.addTask("release", {
        description: releaseTask.description,
        steps: releaseTask.steps,
        env: (releaseTask as any)._env,
        condition: "node ./scripts/should-release.js",
      });
      this.addTask("unconditional-release", {
        description: releaseTask.description,
        steps: releaseTask.steps,
        env: (releaseTask as any)._env,
      });

      const releaseJobSteps: any[] = (
        this.github?.tryFindWorkflow("release") as any
      ).jobs.release.steps;
      const gitRemoteJob = releaseJobSteps.find((it) => it.id === "git_remote");
      prettyAssertEqual(
        gitRemoteJob.run,
        'echo "latest_commit=$(git ls-remote origin -h ${{ github.ref }} | cut -f1)" >> $GITHUB_OUTPUT\ncat $GITHUB_OUTPUT',
        "git_remote step in release workflow did not match expected string, please check if the workaround still works!"
      );
      const previousCommand = gitRemoteJob.run.replace("\n", " && ");

      const cancelCommand =
        'echo "latest_commit=release_cancelled" >> $GITHUB_OUTPUT'; // this cancels the release via a non-matching SHA;
      gitRemoteJob.run = `node ./scripts/should-release.js && (${previousCommand}) || ${cancelCommand}`;
      gitRemoteJob.name +=
        " or cancel via faking a SHA if release was cancelled";
    }

    const staleWorkflow = this.tryFindObjectFile(".github/workflows/stale.yml");
    staleWorkflow?.addOverride("on.schedule", [
      {
        cron: generateRandomCron({ project: this, maxHour: 4, hourOffset: 1 }),
      },
    ]);

    const upgradeWorkflow = this.tryFindObjectFile(
      ".github/workflows/upgrade-main.yml"
    );
    upgradeWorkflow?.addOverride("on.schedule", [
      {
        cron: generateRandomCron({
          project: this,
          maxHour: 0,
          hourOffset: 1,
          schedule: Schedule.Weekly,
        }),
      },
    ]);

    // Submodule documentation generation
    this.gitignore.exclude("API.md"); // ignore the old file, we now generate it in the docs folder
    this.addDevDeps("jsii-docgen@^10.2.3");
    if (jsiiVersion) {
      // NOTE: the below is making a broad assumption that you're passing a range like "~5.3.0" to jsiiVersion
      // If you use that field to pass a very specific version (e.g. "5.3.11") then this might break
      this.addDevDeps(`jsii-rosetta@${jsiiVersion}`);
    } else {
      this.addDevDeps(`jsii-rosetta`);
    }

    const docgen = this.addTask("docgen", {
      description: "Generate documentation for the project",
      steps: [
        {
          exec: [
            "rm -rf docs",
            "rm -f API.md",
            "mkdir docs",
            "jsii-docgen --split-by-submodule -l typescript -l python -l java -l csharp -l go",
            // There is no nice way to tell jsii-docgen to generate docs into a folder so I went this route
            "mv *.*.md docs",
            // Some part of the documentation are too long, we need to truncate them to ~10MB
            "cd docs",
            "ls ./ | xargs sed -i '150000,$ d' $1",
          ].join(" && "),
        },
      ],
    });
    this.postCompileTask.spawn(docgen);
    this.gitignore.include(`/docs/*.md`);
    this.annotateGenerated(`/docs/*.md`);

    // Setting the version in package.json so the golang docs have the correct version
    const unconditionalBump = this.addTask("unconditional-bump", {
      description: "Set the version in package.json to the current version",
      steps: [
        {
          name: "Clear the changelog so that it doesn't get published twice",
          exec: "rm -f $CHANGELOG",
        },
        { builtin: "release/bump-version" },
      ],
      env: {
        OUTFILE: "package.json",
        CHANGELOG: "dist/changelog.md",
        BUMPFILE: "dist/version.txt",
        RELEASETAG: "dist/releasetag.txt",
        RELEASE_TAG_PREFIX: "",
        MIN_MAJOR: String(MIN_MAJOR_VERSION),
      },
    });
    this.preCompileTask.spawn(unconditionalBump);
    // To bump correctly we need to have the completely cloned repo
    (this.buildWorkflow as any).workflow.file.addOverride(
      "jobs.build.steps.0.with.fetch-depth",
      0
    );
    // Undo the changes after compilation
    this.buildWorkflow?.addPostBuildSteps({
      name: "Revert package.json version bump",
      run: "git checkout package.json",
    });

    new CopyrightHeaders(this);
    new DeprecatePackages(this, {
      providerName,
      packageInfo,
      isDeprecated: !!isDeprecated,
    });
    if (!isDeprecated) {
      new ForceRelease(this, { workflowRunsOn });
      patchGoPublishToUseAppToken(
        this.tryFindObjectFile(".github/workflows/force-release.yml")
      );
    }
  }

  private pinGithubActionVersions(pinnedVersions: Record<string, string>) {
    // Use pinned versions of github actions
    Object.entries(pinnedVersions).forEach(([name, sha]) => {
      this.github?.actions.set(name, `${name}@${sha}`);
    });
  }
}

function prettyAssertEqual<T>(subject: T, expected: T, message?: string): void {
  if (subject !== expected) {
    throw new Error(
      `${message ?? "Assertion failed"}: expected ${JSON.stringify(
        expected
      )} but got ${JSON.stringify(subject)}`
    );
  }
}
