/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { javascript, JsonPatch } from "projen";

/**
 * Files an issue when a scheduled dependency upgrade fails.
 *
 * `releaseFailureIssue` covers only the release workflow, and AlertOpenPrs watches
 * for stale PRs rather than failed jobs, so an upgrade failure is otherwise
 * silent. On a weekly cron each one costs a full week of dependency movement:
 * nothing flagged cdktn-provider-awscc's break on 2026-08-10, or this repo's three
 * consecutive failures that July.
 *
 * Its own job, not a step on `upgrade`: permissions are job-wide, so adding
 * `issues: write` there would hand that scope to the persisted checkout credential
 * while dependency lifecycle scripts and `projen upgrade` run. This job checks
 * nothing out and runs no repository code. GH_REPO is required because of that --
 * with no checkout `gh` has no remote to infer from, and a checkout failure is
 * exactly one of the failures this needs to report.
 *
 * Deduplicated on the label so a persistent failure files one issue, not one per
 * run. The label is created here because repo labels are provisioned out-of-band
 * by cdktn-repository-manager and `gh issue create` rejects an unknown one.
 */
export class UpgradeFailureIssue {
  constructor(project: javascript.NodeProject) {
    const workflow = project.tryFindObjectFile(
      ".github/workflows/upgrade-main.yml"
    );

    workflow?.patch(
      JsonPatch.add("/jobs/upgrade_failure_issue", {
        name: "Report a failed upgrade",
        needs: "upgrade",
        // always(), or a failed `upgrade` would skip this with it.
        if: "${{ always() && needs.upgrade.result == 'failure' && github.event_name == 'schedule' }}",
        "runs-on": "ubuntu-latest",
        permissions: { issues: "write" },
        steps: [
          {
            name: "Create issue on failure",
            env: {
              GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
              GH_REPO: "${{ github.repository }}",
              RUN_URL:
                "https://github.com/${{ github.repository }}/actions/runs/${{ github.run_id }}",
            },
            run: [
              "gh label create failed-upgrade --color B60205 --description 'A scheduled dependency upgrade run failed' --force",
              'if [ "$(gh issue list --label failed-upgrade --state open --limit 1 --json number --jq length)" = "0" ]; then',
              '  gh issue create --label failed-upgrade --title "Dependency upgrade failed" --body "The scheduled dependency upgrade run failed: $RUN_URL"',
              "fi",
            ].join("\n"),
          },
        ],
      })
    );
  }
}
