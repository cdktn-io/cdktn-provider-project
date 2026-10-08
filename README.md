# The Future of Terraform CDK

> [!IMPORTANT]
>
> [OCF](https://the-ocf.org/) - [github.com/open-constructs](https://github.com/open-constructs) has stepped up to fork under the new name of [CDK Terrain - cdktn.io](http://cdktn.io)

---

# Terraform CDK Provider Project

A project template for [projen](https://projen.io) to create repositories for prebuilt provider packages for [CDK Terrain](https://cdktn.io).

## Usage

The provider repos are entirely auto generated from the configuration contained in this repo here. There's no manual interaction necessary, except for creating the initial repository - using this repo. The `cdktn get` command is executed as part of the build pipeline in Github Actions. These jobs are executed on a schedule. Hence, new provider changes will be picked up automatically.

### Creating a new provider

> [!NOTE] 
> Only Offical Terraform Providers or Hashicorp partner Terraform Poviders will be accepted for pre-built provider generation.

Add a new repository [over here](https://github.com/cdktn-io/cdktn-repository-manager).

In the newly created repository, all we need is a `.projenrc.js` file like this:

```js
const { CdktnProviderProject } = require('@cdktn/provider-project');
const { Semver } = require('projen');

const project = new CdktnProviderProject({
  terraformProvider: "aws@~> 2.0"
});

project.synth();
```

Adjust the `terraformProvider` attribute as required and run the following commands:

```
npm install @cdktn/provider-project@latest
npx projen
pnpm install
```

This will generate an entire repository ready to be published, including Github Workflows for publishing NPM, Pypi and maven packages. The only thing which is needed to be set manually are the tokens for these registries:

- `NPM_TOKEN` (only when `npmTrustedPublishing` is false; the cdktn-io provider repositories publish via OIDC and hold no npm token)
- `TWINE_PASSWORD` / `TWINE_USERNAME` (only when `pypiTrustedPublishing` is false)
- `MAVEN_GPG_PRIVATE_KEY`
- `MAVEN_GPG_PRIVATE_KEY_PASSPHRASE`
- `MAVEN_PASSWORD`
- `MAVEN_USERNAME`

### Updating an existing Provider

Commit and push the required changes to this repository here and wait for the auto-release to happen. Once released, you can run the following commands in the target provider repository:

```
npm install @cdktn/provider-project@latest
npx projen
pnpm install
```

Commit, push and check for the auto-released version.

### Deprecating old package versions

Deprecating published versions is a manual, maintainer-driven step. The release workflow used to carry an automated `deprecate` job that ran `npm deprecate` after each release of a deprecated provider; it was removed because provider repositories no longer hold an `NPM_TOKEN` (npm publishing uses OIDC trusted publishing, which cannot authorize `npm deprecate`).

- **npm**: a maintainer with publish rights on the package runs, locally:

  ```
  npm deprecate <pkg>@"<range>" "<message>"
  ```

  e.g. `npm deprecate @cdktn/provider-random@"<12.0.0" "See https://cdktn.io/docs/concepts/providers#import-providers for how to generate the bindings locally."`. An empty message (`""`) un-deprecates.
- **PyPI**: there is no deprecation mechanism ([pypi/warehouse#345](https://github.com/pypi/warehouse/issues/345)). Leave published releases alone. Do not yank them, because pip then skips them for any requirement that isn't an exact `==` pin. The deprecation notice in the README (rendered on the PyPI project page) is the signal.
- **Go**: still automated -- a provider marked `isDeprecated` gets a `// Deprecated:` comment prepended to its `go.mod` during the Go publish job.
- **Maven / NuGet**: no automated path; NuGet supports deprecation only via the nuget.org web UI.

## Development

Whatever needs to be changed in the downstream [provider repositories](https://github.com/cdktn-io/cdktn-repository-manager) should be done via the [code definitions](./src/index.ts) here.

For local development, [pnpm link](https://pnpm.io/cli/link) might be quite helpful for testing.
