/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { readFileSync } from "fs";
import { join } from "path";
import { validateWorkflow } from "@action-validator/core";
import { GithubWorkflow } from "projen/lib/github";
import { parse as parseYaml } from "yaml";
import { synthSnapshot } from "./util/synth";
import { getProject } from "./util/test-project";

const project = getProject();

describe("GitHub Actions validation", () => {
  const snapshot = synthSnapshot(getProject());

  project.github!.workflows.forEach((workflow: GithubWorkflow) => {
    test(workflow.file!.path, () => {
      const state = validateWorkflow(snapshot[workflow.file!.path]);

      expect(state.errors).toEqual([]);
    });
  });
});

describe("this repo's own upgrade workflow", () => {
  // The notification reached provider repos through src/index.ts, which does not
  // apply to this repo -- so the one repo that ate three consecutive silent weekly
  // failures was the only one that still could not report them. Both now go
  // through UpgradeFailureIssue; this guards against losing it here again.
  const workflow = parseYaml(
    readFileSync(
      join(__dirname, "..", ".github/workflows/upgrade-main.yml"),
      "utf8"
    )
  );

  test("reports a failed upgrade run", () => {
    const job = workflow.jobs.upgrade_failure_issue;

    expect(job).toBeDefined();
    expect(job.needs).toBe("upgrade");
    expect(job.if).toContain("always()");
    expect(job.if).toContain("needs.upgrade.result == 'failure'");
    // No checkout, so `gh` has no remote to infer the repository from.
    expect(job.steps[0].env.GH_REPO).toBe("${{ github.repository }}");
  });

  test("keeps issue-write off the job that runs dependency code", () => {
    // Permissions are job-wide: `issues: write` on `upgrade` would expose that
    // scope to the persisted checkout credential while lifecycle scripts run.
    expect(workflow.jobs.upgrade.permissions.issues).toBeUndefined();
    expect(workflow.jobs.upgrade_failure_issue.permissions).toEqual({
      issues: "write",
    });
  });
});
