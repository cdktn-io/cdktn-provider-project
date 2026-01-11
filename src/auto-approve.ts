/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { javascript } from "projen";
import { JobPermission } from "projen/lib/github/workflows-model";

/**
 * Approves PRs with the "auto-approve" label
 */
export class AutoApprove {
  constructor(project: javascript.NodeProject) {
    const workflow = project.github?.addWorkflow("auto-approve");

    if (!workflow) throw new Error("no workflow defined");

    workflow.on({
      pullRequestTarget: {
        types: ["opened", "labeled", "ready_for_review", "reopened"],
      },
    });

    (workflow.concurrency as any) = {
      group: "${{ github.workflow }}-${{ github.head_ref }}",
    };

    const maintainerStatuses = `fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]')`;
    workflow.addJobs({
      approve: {
        runsOn: ["ubuntu-latest"],
        if: "contains(github.event.pull_request.labels.*.name, 'auto-approve') && github.event.pull_request.draft == false",
        steps: [
          {
            name: "Generate token",
            id: "generate_token",
            uses: "actions/create-github-app-token",
            with: {
              "app-id": "${{ env.PROJEN_APP_ID }}",
              "private-key": "${{ env.PROJEN_APP_PRIVATE_KEY }}",
            },
          },
          {
            name: "Checkout PR",
            uses: "actions/checkout",
            with: {
              ref: "${{ env.GIT_REF }}",
              repository: "${{ env.GIT_REPO }}",
            },
          },
          {
            name: "Auto-approve PRs by other users as team-cdk-terrain",
            if: `github.event.pull_request.user.login != 'team-cdk-terrain[bot]' && (contains(${maintainerStatuses}, github.event.pull_request.author_association) || github.actor == 'dependabot[bot]')`,
            run: "gh pr review $PR_ID --approve",
            env: {
              GH_TOKEN: "${{ steps.generate_token.outputs.token }}",
            },
          },
          {
            name: "Auto-approve PRs by team-cdk-terrain[bot] as github-actions[bot]",
            if: "github.event.pull_request.user.login == 'team-cdk-terrain[bot]'",
            run: "gh pr review $PR_ID --approve",
            env: {
              GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
            },
          },
        ],
        permissions: {
          contents: JobPermission.READ,
          pullRequests: JobPermission.WRITE,
        },
        env: {
          GIT_REF: "${{ github.event.pull_request.head.ref }}",
          GIT_REPO: "${{ github.event.pull_request.head.repo.full_name }}",
          PR_ID: "${{ github.event.pull_request.number }}",
        },
      },
    });
  }
}
