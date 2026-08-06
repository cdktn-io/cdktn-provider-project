/* eslint-disable @typescript-eslint/no-require-imports */
import assert = require("assert");
import { pascalCase } from "change-case";
import { Component, TextFile, cdk, github, JsonPatch } from "projen";
import { JobStep } from "projen/lib/github/workflows-model";
import {
  NodePackageManager,
  PnpmWorkspaceYamlSchemaNodeLinker,
  UpgradeDependenciesSchedule,
} from "projen/lib/javascript";
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

/**
 * First-party packages that are exempt from the dependency-upgrade cooldown.
 *
 * The `cooldown: 4` below reaches the generated upgrade task as
 * `pnpm update --config.minimum-release-age=5760`, which gates *every* package
 * -- including the ones we publish ourselves. That is backwards for those: a
 * fix released here cannot reach the fleet for four days, which is exactly the
 * window in which we need it to move. The cooldown exists to give a compromised
 * third-party release time to be flagged; for packages published from repos we
 * own, with trusted publishing and an audit gate on their own releases, it buys
 * nothing that we do not already control.
 *
 * `cdktn` and `cdktn-cli` are here for the same reason: a provider repo has to
 * be able to rebuild against a freshly released CDKTN, especially after a major
 * one. They are also version-pinned together by `CdktfConfig`, so excluding one
 * without the other would only half-apply.
 *
 * pnpm honours this from `pnpm-workspace.yaml` even though `minimumReleaseAge`
 * itself arrives on the command line; it matches on package name and applies to
 * every version of that package. Everything not listed here stays gated.
 */
const MINIMUM_RELEASE_AGE_EXCLUDE = [
  "@cdktn/provider-project",
  "cdktn",
  "cdktn-cli",
];

export interface CdktnProviderProjectOptions extends cdk.JsiiProjectOptions {
  readonly useCustomGithubRunner?: boolean;
  /**
   * V8 heap ceiling in MiB, written as `--max-old-space-size` into the global
   * `NODE_OPTIONS` in `.projen/tasks.json`.
   *
   * Must be a positive safe integer. Node refuses to start on a malformed
   * value (`--max-old-space-size=1.5` and `=NaN` are both rejected before any
   * script runs), and `0` restores V8's own default rather than applying a
   * ceiling -- so an invalid value here would break every task in the
   * generated repo, far from this call site. It is validated at synth time.
   *
   * Leave unset to take the default for the runner class:
   * `DEFAULT_HEAP_MB_CUSTOM_RUNNER` (20480, on 32GB custom runners) or
   * `DEFAULT_HEAP_MB_HOSTED_RUNNER` (6656, on 7GB GitHub-hosted runners).
   *
   * Set it only for a provider that still OOMs on that default.
   * `--max-old-space-size` is a *ceiling*, not a reservation: lowering it
   * cannot slow down providers that never approach it, it only makes V8
   * collect harder instead of letting the kernel OOM-kill the process.
   *
   * @default - DEFAULT_HEAP_MB_CUSTOM_RUNNER if `useCustomGithubRunner`,
   * otherwise DEFAULT_HEAP_MB_HOSTED_RUNNER
   */
  readonly nodeHeapSizeMb?: number;
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
  /**
   * Use trusted publishing for publishing to pypi.org
   * Needs to be pre-configured on PyPI to work.
   *
   * The `release_pypi` job keeps whatever runner the project is configured for.
   * PyPI, unlike npm, does not restrict trusted publishing to GitHub-hosted
   * runners -- trust is bound to the workflow ref, and the OIDC token is minted
   * from ACTIONS_ID_TOKEN_REQUEST_URL, which is available on any runner with
   * `id-token: write`.
   *
   * @see https://docs.pypi.org/trusted-publishers/
   *
   * @default - false
   */
  readonly pypiTrustedPublishing?: boolean;
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
  "actions/setup-node": "48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e", // v6.4.0
  "actions/setup-python": "a309ff8b426b58ec0e2a45f0f869d46889d02405", // v6.2.0
  "actions/stale": "b5d41d4e1d5dceea10e7104786b73624c18a190f", // v10.2.0
  "actions/upload-artifact": "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", // v7.0.1
  "amannn/action-semantic-pull-request":
    "48f256284bd46cdaab1048c3721360e808335d50", // v6.1.1
  "dessant/lock-threads": "7266a7ce5c1df01b1c6db85bf8cd86c737dadbe7", // v6.0.0
  "hashicorp/setup-copywrite": "32638da2d4e81d56a0764aa1547882fc4d209636", // v1.1.3
  "hashicorp/setup-terraform": "5e8dbf3c6d9deaf4193ca7a8fb23f2ac83bb6c85", // v4.0.0
  "imjohnbo/issue-bot": "3188c6ce06249206709d3b1f274d0d4c5a521601", // v3.4.5
  "peter-evans/create-pull-request": "5f6978faf089d4d20b00c7766989d076bb2fc7f1", // v8.1.1
  "slackapi/slack-github-action": "45a88b9581bfab2566dc881e2cd66d334e621e2c", // v3.0.3
  "actions/create-github-app-token": "29824e69f54612133e76f7eaac726eef6c875baf", // v2.2.1
  // projen emits this unpinned as `pnpm/action-setup@v5` once packageManager is pnpm
  "pnpm/action-setup": "fc06bc1257f339d1d5d8b3a19a8cae5388b55320", // v5
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
      pypiTrustedPublishing,
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
        trustedPublishing: pypiTrustedPublishing ?? false,
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
          // NOTE: the "Setup pnpm" step this job needs is inserted by
          // GoPublishJobPatch at synth time, not here -- it has to read
          // `this.package.pnpmVersion`, which does not exist yet at super().
          {
            name: "Checkout",
            uses: "actions/checkout",
            with: {
              path: ".repo",
            },
          },
          {
            name: "Install Dependencies",
            run: "cd .repo && pnpm install --frozen-lockfile",
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
      eslint: false,
      packageManager: NodePackageManager.PNPM,
      // Provider repos run jsii-pacmak over bundled deps exactly as this project
      // does, so they need the hoisted linker too -- see the note in .projenrc.ts.
      // It must be in pnpm-workspace.yaml, not .npmrc, or pnpm 11 ignores it.
      pnpmOptions: {
        workspaceYamlOptions: {
          nodeLinker: PnpmWorkspaceYamlSchemaNodeLinker.HOISTED,
          auditConfig: {
            // Same flat-range artifact this project ignores for itself:
            // GHSA-mh99-v99m-4gvg declares affected "<=5.0.7", which naively matches
            // the 1.x line. Provider repos reach brace-expansion@1 via
            // cdktn-cli > @cdktn/hcl2cdk > glob > minimatch@3, and there is no fixed
            // 1.x to move to -- forcing 5.0.8 would break minimatch@3, which requires
            // ^1.1.7. Dev tooling only; never shipped.
            ignoreGhsas: ["GHSA-mh99-v99m-4gvg"],
          },
          // Let first-party releases skip the `cooldown` below -- see the note on
          // the constant. Third-party deps are unaffected.
          minimumReleaseAgeExclude: MINIMUM_RELEASE_AGE_EXCLUDE,
        },
      },
      depsUpgrade: !isDeprecated,
      depsUpgradeOptions: {
        // Skip versions published in the last 4 days, so a compromised release has
        // time to be flagged before an auto-merging upgrade PR pulls it in. Waived
        // for the packages in MINIMUM_RELEASE_AGE_EXCLUDE.
        cooldown: 4,
        workflowOptions: {
          labels: ["automerge", "auto-approve", "dependencies"],
          schedule: UpgradeDependenciesSchedule.WEEKLY,
        },
      },
      auditDeps: !isDeprecated,
      auditDepsOptions: {
        level: "high",
        runOn: "build",
      },
      publishToPypi: packageInfo.python,
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
        // projen >=0.100 moved the `mergify` project option under githubOptions
        mergify: false,
      },
    });

    this.addDevDeps(
      "dot-prop@^5.2.0",
      // ^1.1.0 could never leave the 1.x line, which drags in an old
      // @actions/http-client and with it undici <6.24.0 -- three high advisories
      // (GHSA-vrm6-8vpv-qv8q, GHSA-v9p9-hfj2-hcw8, and the <6.27.0 fragment-count
      // DoS). 3.x depends on @actions/http-client ^4 -> undici ^6.23.0, resolving
      // to 6.28.0. NOTE: 3.x is ESM-only, so check-for-upgrades.js loads it with a
      // dynamic import rather than `require`.
      "@actions/core@^3.0.0",
      "@action-validator/core",
      "@action-validator/cli"
    );

    // Default memory is 7GB: https://docs.github.com/en/actions/using-github-hosted-runners/about-github-hosted-runners#supported-runners-and-hardware-resources
    // Custom Runners we use have 32GB of memory.
    //
    // The custom-runner ceiling has to sit below the memory a job can ACTUALLY
    // get, or V8 never feels pressure to collect and the kernel OOM-kills the
    // process first. The signature is distinctive: the step sits in_progress with
    // a null completedAt (killed process, not a non-zero exit) and the job burns
    // ~12-13m instead of the ~4m a healthy run takes. See #34.
    //
    // "Below available RAM" is not the same as "below the advertised RAM", which
    // is what the first two attempts at this number got wrong. depot-ubuntu-24.04-8
    // advertises 32GB, but Depot reserves 8GB of it for the in-memory disk
    // accelerator ("a portion of the memory on the runner host for a disk
    // accelerator, backed by a RAM disk"), leaving ~24GB usable -- and the
    // workspace lives on that RAM disk, so the generated bindings squeeze the same
    // pool pacmak is growing into. 31744 (~97% of 32GB) and then 28672 (~90%) both
    // sat ABOVE that real ceiling, so lowering it the first time changed nothing:
    // cdktn-provider-datadog died at 12m21s on 31744 and again at 12m23s/12m40s on
    // 28672, same silent kill.
    //
    // Empirically: datadog's package:go, which had never once completed, finished
    // its `Create go artifact` step in 3m01s at 16384 (run 30824787291). 20480
    // keeps ~4GB below the ~24GB usable line while giving pacmak more room than the
    // verified-good value. This is a ceiling, not a reservation -- providers that
    // never approach it are unaffected, so it costs nothing to leave headroom here.
    const DEFAULT_HEAP_MB_CUSTOM_RUNNER = 20480;
    const DEFAULT_HEAP_MB_HOSTED_RUNNER = 6656; // 6.5GB of 7GB

    // `nodeHeapSizeMb` is public API and, via jsii, reachable from Python, Go,
    // Java and .NET where `number` is even looser than TypeScript's. Node
    // refuses to start on a malformed ceiling -- `--max-old-space-size=1.5`
    // and `=NaN` are both rejected before any script runs -- and `0` silently
    // restores V8's default instead of applying a limit. Interpolating an
    // unchecked value would therefore break every task in the generated repo,
    // surfacing as an inscrutable startup failure in CI rather than here.
    assert(
      options.nodeHeapSizeMb === undefined ||
        (Number.isSafeInteger(options.nodeHeapSizeMb) &&
          options.nodeHeapSizeMb > 0),
      `nodeHeapSizeMb must be a positive safe integer (MiB), got ${options.nodeHeapSizeMb}`
    );

    const maxOldSpaceSize = String(
      options.nodeHeapSizeMb ??
        (options.useCustomGithubRunner
          ? DEFAULT_HEAP_MB_CUSTOM_RUNNER
          : DEFAULT_HEAP_MB_HOSTED_RUNNER)
    );

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

      // NPM OIDC doesn't support self-hosted runners yet
      this.github
        ?.tryFindWorkflow("release")
        ?.file?.patch(
          JsonPatch.replace("/jobs/release_npm/runs-on", "ubuntu-latest")
        );
    }

    // NOTE: release_pypi deliberately stays on whatever runner the project is
    // configured for. Unlike npm, PyPI places no restriction on the runner
    // environment: publib-pypi mints its token with `python3 -m id pypi` against
    // ACTIONS_ID_TOKEN_REQUEST_URL, which GitHub injects on any runner given
    // `id-token: write`, and PyPI's trust is bound to the workflow ref, not the
    // runner. Forcing this job onto a hosted runner would also strand it with the
    // 20GB NODE_OPTIONS heap ceiling that useCustomGithubRunner writes into
    // .projen/tasks.json, on a box with far less RAM than that -- and unlike
    // package:js, package:python is a real jsii-pacmak transpile.

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

    // release: Go — complete the hand-built Go publish job. Deprecated projects
    // still publish Go, so they still need the pnpm setup; only the App token is
    // conditional, since they do not push new module versions.
    new GoPublishJobPatch(this, {
      appTokenRepository: isDeprecated
        ? undefined
        : packageInfo.publishToGo?.moduleName?.split("/").pop() ?? "",
    });

    // Fix maven issue (https://github.com/cdklabs/publib/pull/777)
    //
    // The publish jobs don't exist until Release synthesizes, and the step's index
    // within release_maven shifts whenever the job gains a step -- switching the
    // package manager to pnpm inserts a "Setup pnpm" step, which silently moved the
    // old hardcoded /steps/10/ onto a step with no env at all. Resolve the step by
    // what it runs, in preSynthesize, so neither problem can recur.
    new MavenOptsPatch(this);

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
      assert(
        gitRemoteJob,
        "git_remote step not found in release workflow, please check if the workaround still works!"
      );
      // We wrap whatever projen generated in a should-release guard rather than
      // rewriting it, so assert only the two properties the wrapping actually
      // depends on. Pinning to projen's exact wording broke the whole fleet
      // once already: projen 0.101 changed `${{ github.ref }}` to `"$GITHUB_REF"`
      // and every provider repo's upgrade-main started failing at synth.
      assert(
        typeof gitRemoteJob.run === "string" &&
          gitRemoteJob.run.includes("git ls-remote") &&
          gitRemoteJob.run.includes("latest_commit="),
        `git_remote step no longer sets latest_commit from git ls-remote, please check if the workaround still works! Got: ${JSON.stringify(
          gitRemoteJob.run
        )}`
      );
      // Fold *every* line: projen emits two today, but String#replace with a
      // string pattern only folds the first if that ever grows.
      const previousCommand = gitRemoteJob.run.split("\n").join(" && ");

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
        // projen 0.101 removed the combined `release/bump-version` builtin and split
        // it into resolve-latest-tag -> suggest-version-bump -> apply-version-bump,
        // handing results forward via step `outputEnv` captures. apply on its own
        // throws "neither BUMP_TYPE nor SUGGESTED_BUMP is set", so all three are
        // needed. Mirrors projen's own bump task (lib/version.js:128-144).
        { builtin: "release/resolve-latest-tag", outputEnv: "LATEST_TAG" },
        {
          builtin: "release/suggest-version-bump",
          outputEnv: "SUGGESTED_BUMP",
        },
        { builtin: "release/apply-version-bump" },
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
      // Folds the manual force-release behaviour into release.yml behind a
      // workflow_dispatch trigger, so npm/PyPI OIDC trusts a single workflow.
      new ForceRelease(this);
    }
  }

  private pinGithubActionVersions(pinnedVersions: Record<string, string>) {
    // Use pinned versions of github actions
    Object.entries(pinnedVersions).forEach(([name, sha]) => {
      this.github?.actions.set(name, `${name}@${sha}`);
    });
  }
}

/**
 * Sets MAVEN_OPTS on the maven publish step and drops the unused
 * MAVEN_STAGING_PROFILE_ID, resolving the step by the command it runs.
 *
 * Runs in preSynthesize because the publish jobs are added by Release during
 * synthesis, so the job does not exist yet at construction time.
 *
 * @see https://github.com/cdklabs/publib/pull/777
 */
class MavenOptsPatch extends Component {
  public preSynthesize() {
    const workflow = github.GitHub.of(this.project)?.tryFindWorkflow("release");
    const steps: JobStep[] | undefined = (workflow as any)?.jobs?.release_maven
      ?.steps;
    assert(
      steps,
      "release_maven job not found, please check if the MAVEN_OPTS workaround still works!"
    );
    const step = steps.find((s) => s.run?.includes("publib-maven"));
    assert(
      step?.env,
      "no publib-maven step with an env block in release_maven, please check if the MAVEN_OPTS workaround still works!"
    );
    // Mutate the step directly rather than JsonPatch-ing the rendered file: the
    // publisher prepends tool-setup steps at render time, so in-memory indices do
    // not match rendered ones, and a JSON Pointer would have to encode that offset.
    // See https://stackoverflow.com/questions/70153962/nexus-staging-maven-plugin-maven-deploy-failed-an-api-incompatibility-was-enco
    step.env.MAVEN_OPTS =
      "--add-opens=java.base/java.util=ALL-UNNAMED --add-opens=java.base/java.lang.reflect=ALL-UNNAMED --add-opens=java.base/java.text=ALL-UNNAMED --add-opens=java.desktop/java.awt.font=ALL-UNNAMED";
    // This is no longer used.
    delete step.env.MAVEN_STAGING_PROFILE_ID;
  }
}

/**
 * Fixes up the hand-built Go publish job, which `publishToGo.prePublishSteps`
 * has to declare before `super()` and therefore cannot build completely:
 *
 * - inserts the "Setup pnpm" step that projen injects into the workflows it
 *   generates itself but not into hand-built ones, at the project's own pnpm
 *   version rather than a copy of it. Applies to deprecated projects too: they
 *   still run this job, so they still need pnpm on PATH;
 * - pushes the module with a GitHub App installation token instead of the
 *   default `GO_GITHUB_TOKEN` secret, when `appTokenRepository` is given.
 *
 * Runs in preSynthesize for two reasons: the publish jobs are added by Release
 * during synthesis, so the job does not exist at construction time, and
 * `this.package.pnpmVersion` is only readable after `super()`.
 *
 * Both steps are spliced in immediately before the step that needs them,
 * resolved by what that step runs. Never by index: release_golang's indices
 * shift whenever the job gains a step -- adding "Setup pnpm" is exactly what
 * moved the old hardcoded /steps/17/env onto a step with no env at all.
 */
class GoPublishJobPatch extends Component {
  private readonly appTokenRepository?: string;

  constructor(
    private readonly nodeProject: cdk.JsiiProject,
    options: { appTokenRepository?: string }
  ) {
    super(nodeProject);
    this.appTokenRepository = options.appTokenRepository;
  }

  public preSynthesize() {
    const workflow = github.GitHub.of(this.project)?.tryFindWorkflow("release");
    const steps: JobStep[] | undefined = (workflow as any)?.jobs?.release_golang
      ?.steps;
    assert(
      steps,
      "release_golang job not found, please check if the Go publish workarounds still work!"
    );

    // Without pnpm on PATH the install below exits 127. Before the pnpm
    // migration reached this job it ran `yarn install`, which failed outright
    // against a package.json declaring `packageManager: "pnpm@..."`.
    const installIndex = steps.findIndex((s) =>
      s.run?.includes("pnpm install")
    );
    assert(
      installIndex >= 0,
      "no pnpm install step in release_golang, please check if the Setup pnpm workaround still works!"
    );
    steps.splice(installIndex, 0, {
      name: "Setup pnpm",
      uses: "pnpm/action-setup",
      with: { version: this.nodeProject.package.pnpmVersion },
    });

    if (!this.appTokenRepository) return;

    const index = steps.findIndex((s) => s.run?.includes("publib-golang"));
    const step = steps[index];
    assert(
      step?.env,
      "no publib-golang step with an env block in release_golang, please check if the Go publish token workaround still works!"
    );

    const goPublishToken = github.GithubCredentials.fromApp({
      appIdSecret: "PROJEN_APP_ID",
      privateKeySecret: "PROJEN_APP_PRIVATE_KEY",
      owner: "${{ github.repository_owner }}",
      repositories: [this.appTokenRepository],
      permissions: { contents: github.workflows.AppPermission.WRITE },
    });

    // Mutate the steps directly rather than JsonPatch-ing the rendered file, so
    // the token-minting step stays anchored to the publish step it feeds.
    steps.splice(index, 0, goPublishToken.setupSteps[0]);
    // GitHub App installation tokens (ghs_*) require the `x-access-token`
    // username when used in HTTPS git URLs. publib renders this env var
    // verbatim into `https://${GITHUB_TOKEN}@github.com/...`, so without the
    // prefix the push 401s and falls back to a TTY password prompt.
    step.env.GITHUB_TOKEN = `x-access-token:${goPublishToken.tokenRef}`;
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
