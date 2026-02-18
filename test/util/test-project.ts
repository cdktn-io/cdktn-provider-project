/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { CdktnProviderProject, CdktnProviderProjectOptions } from "../../src";

export const getProject = (
  opts: Partial<CdktnProviderProjectOptions> = {}
): CdktnProviderProject =>
  new CdktnProviderProject({
    terraformProvider: "random@~>2.0",
    cdktnVersion: "0.10.3",
    constructsVersion: "10.0.0",
    jsiiVersion: "~5.2.0",
    typescriptVersion: "~5.2.0", // NOTE: this should be the same major/minor version as JSII
    devDeps: ["@cdktn/provider-project@^0.0.0"],
    // NOTE: the below options aren't required to be passed in practice and only need to be here for the test
    // This is because JSII prevents us from declaring the options as a Partial<cdk.JsiiProjectOptions>
    name: "test",
    author: "cdktn-team",
    authorAddress: "https://github.com/cdktn-io",
    defaultReleaseBranch: "main",
    repositoryUrl: "github.com/cdktn-io/cdktn",
    forceMajorVersion: 42,
    ...opts,
  });
