/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { cdk, Component } from "projen";
import { GithubWorkflow } from "projen/lib/github";

/**
 * Folds the former standalone `force-release` workflow into the projen-generated
 * `release` workflow.
 *
 * npm trusted publishing (OIDC) only allows a *single* trusted publisher per
 * package, pinned to one repository + workflow filename. A second workflow
 * (the old `force-release.yml`) that also publishes to npm via OIDC can
 * therefore never be trusted. To keep a single OIDC entrypoint we fold the
 * manual "force release" behaviour into `release.yml` behind a
 * `workflow_dispatch` trigger. PyPI OIDC technically allows multiple trusted
 * publishers, but we keep it aligned with npm for consistency.
 *
 * Behaviour:
 * - On `push`: unchanged, a conditional release gated by `should-release`.
 * - On `workflow_dispatch`: force-releases a specific commit (`sha`) by running
 *   `unconditional-release` and publishes only to the package managers selected
 *   via the `publish_to_*` inputs.
 */
export class ForceRelease extends Component {
  private readonly releaseWorkflow: GithubWorkflow;

  constructor(project: cdk.JsiiProject) {
    super(project);

    const releaseWorkflow = project.github?.tryFindWorkflow("release") as
      | GithubWorkflow
      | undefined;
    if (!releaseWorkflow) {
      throw new Error("Could not find release workflow, aborting");
    }
    this.releaseWorkflow = releaseWorkflow;

    // Extend the existing triggers (push + an empty workflow_dispatch added by
    // projen) with the manual force-release inputs. `on()` merges, so the push
    // trigger is preserved.
    releaseWorkflow.on({
      workflowDispatch: {
        inputs: {
          sha: {
            type: "string",
            required: true,
            description: "The sha of the commit to release",
          },
          publish_to_npm: {
            type: "boolean",
            default: false,
            description: "Whether or not to publish to NPM",
          },
          publish_to_maven: {
            type: "boolean",
            default: false,
            description: "Whether or not to publish to Maven",
          },
          publish_to_pypi: {
            type: "boolean",
            default: false,
            description: "Whether or not to publish to PyPi",
          },
          publish_to_nuget: {
            type: "boolean",
            default: false,
            description: "Whether or not to publish to NuGet",
          },
          publish_to_go: {
            type: "boolean",
            default: false,
            description: "Whether or not to publish to Go",
          },
        },
      },
    });
  }

  /**
   * The publish jobs (`release_npm`, `release_pypi`, ...) are only added to the
   * workflow during `Release.preSynthesize()`. Because this component is
   * constructed last, running our mutations here (after that) lets us patch
   * every job in-memory by step *name* instead of relying on brittle array
   * indices.
   */
  preSynthesize() {
    const wf = this.releaseWorkflow as any;

    const DISPATCH = "github.event_name == 'workflow_dispatch'";
    const NOT_DISPATCH = "github.event_name != 'workflow_dispatch'";
    // On push, only publish for a brand-new, still-current release.
    const PUSH_PUBLISH =
      "needs.release.outputs.tag_exists != 'true' && needs.release.outputs.latest_commit == github.sha";

    // --- release job: branch behaviour by trigger -------------------------
    const releaseSteps: any[] = wf.getJob("release").steps;

    const checkout = releaseSteps.find((s) => s.name === "Checkout");
    checkout.with = {
      ...checkout.with,
      // Force-release checks out the requested commit; push uses the default ref.
      ref: `\${{ ${DISPATCH} && inputs.sha || '' }}`,
    };

    const releaseStep = releaseSteps.find((s) => s.name === "release");
    releaseStep.run = [
      `if [ "\${{ github.event_name }}" = "workflow_dispatch" ]; then`,
      "  npx projen unconditional-release",
      "else",
      "  npx projen release",
      "fi",
    ].join("\n");

    // `should-release` only makes sense for automatic (push) releases.
    releaseSteps.find((s) => s.id === "git_remote").if = NOT_DISPATCH;

    // The publish jobs download this artifact, so it must also be uploaded on a
    // manual dispatch (where latest_commit is never computed).
    const artifactGuard = `\${{ ${DISPATCH} || steps.git_remote.outputs.latest_commit == github.sha }}`;
    releaseSteps.find((s) => s.name === "Backup artifact permissions").if =
      artifactGuard;
    releaseSteps.find((s) => s.name === "Upload artifact").if = artifactGuard;

    // --- deprecate job: skip on manual dispatch ---------------------------
    const deprecate = wf.getJob("deprecate");
    if (deprecate) {
      deprecate.if = NOT_DISPATCH;
    }

    // --- GitHub release job ----------------------------------------------
    const githubJob = wf.getJob("release_github");
    if (githubJob) {
      // (Re)create the GitHub release whenever the tag is new; on push also
      // require the commit to still be the latest.
      githubJob.if = `needs.release.outputs.tag_exists != 'true' && (${DISPATCH} || needs.release.outputs.latest_commit == github.sha)`;
      const ghReleaseStep = githubJob.steps.find(
        (s: any) => s.name === "Release"
      );
      ghReleaseStep.env = {
        ...ghReleaseStep.env,
        // Target the dispatched commit instead of the workflow's own sha.
        GITHUB_REF: `\${{ ${DISPATCH} && inputs.sha || github.ref }}`,
        GITHUB_SHA: `\${{ ${DISPATCH} && inputs.sha || github.sha }}`,
      };
      this.suppressManualFailureIssue(githubJob);
    }

    // --- per-package publish jobs ----------------------------------------
    const publishJobs: Array<[string, string]> = [
      ["release_npm", "publish_to_npm"],
      ["release_maven", "publish_to_maven"],
      ["release_pypi", "publish_to_pypi"],
      ["release_nuget", "publish_to_nuget"],
      ["release_golang", "publish_to_go"],
    ];
    for (const [jobName, toggle] of publishJobs) {
      const job = wf.getJob(jobName);
      if (!job) continue;
      job.if = `(${NOT_DISPATCH} && ${PUSH_PUBLISH}) || (${DISPATCH} && inputs.${toggle})`;
      this.suppressManualFailureIssue(job);
    }
  }

  /**
   * Manual force-releases should not open "failed-release" issues, matching the
   * behaviour of the previous standalone force-release workflow.
   */
  private suppressManualFailureIssue(job: any) {
    const createIssue = job.steps.find((s: any) => s.name === "Create Issue");
    if (createIssue) {
      createIssue.if =
        "${{ failure() && github.event_name != 'workflow_dispatch' }}";
    }
  }
}
