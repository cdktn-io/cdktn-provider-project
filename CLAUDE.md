# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Projen (https://projen.io) project template for creating CDKTF (CDK for Terraform) pre-built provider binding repositories. This is a fork maintained by CDK Terrain (cdktn.io) after HashiCorp's sunset announcement on December 10, 2025.

**Purpose**: This repository generates the structure and workflows for individual provider repositories. Changes made here propagate to all downstream provider repos (managed at cdktn-io/repository-manager).

## Key Concepts

- **Provider Projects**: This template is used to bootstrap provider repos (e.g., `cdktn-provider-aws`, `cdktn-provider-google`) that contain pre-built TypeScript, Python, Java, C#, and Go bindings for Terraform providers
- **Projen-based**: Everything is code-generated from `.projenrc.ts` - never manually edit generated files
- **Downstream Impact**: Changes here affect hundreds of provider repositories when they upgrade to newer versions of `@cdktn/provider-project`

## Common Commands

### Development
```bash
npx projen                    # Regenerate all project files from .projenrc.ts
npm run build                 # Compile TypeScript and run all build steps
npm run compile               # Compile TypeScript only
npm test                      # Run Jest tests
npm run eslint                # Lint TypeScript files
npm run eslint:fix            # Fix auto-fixable linting issues
npm run validate-workflows    # Validate GitHub Actions workflow YAML files
```

### Testing Changes
```bash
yarn link                     # Create a local link for testing in provider repos
# In a provider repo:
yarn link @cdktn/provider-project
npx projen                    # Apply the linked version
```

## Architecture

### Core Components

**`src/index.ts` - CdktnProviderProject Class**
The main export. Creates a Jsii project with:
- Multi-language package publishing (npm, PyPI, Maven, NuGet, Go)
- GitHub Actions workflows for build, release, and provider upgrades
- Automated dependency management and version bumping
- Provider-specific configuration (namespace, version constraints)
- Custom runners for memory-intensive builds (configurable via `useCustomGithubRunner`)

**Configuration Files Generated for Provider Repos:**

**NOTE**: For Legacy support these MUST not be renamed

- `cdktf.json` - Tells `cdktf get` which provider to fetch
- `src/version.json` - Tracks the actual provider version after fetch
- Custom GitHub workflows for provider upgrades, auto-merge, and releases

### Component Modules

Each file in `src/` adds specific functionality to generated provider projects:

- **`cdktf-config.ts`**: Sets up CDKTF dependencies, creates fetch task (`cdktf get`), configures build scripts
- **`provider-upgrade.ts`**: Daily cron workflow that checks for new provider versions and creates auto-merge PRs
- **`readme.ts`**: Generates comprehensive README with package installation instructions for all languages
- **`auto-approve.ts` / `automerge.ts`**: GitHub workflows for automated PR approval/merging
- **`copyright-headers.ts`**: Adds HashiCorp copyright headers using the `copywrite` tool
- **`deprecate-packages.ts`**: Handles deprecation notices when `isDeprecated: true`
- **`lock-issues.ts`**: Auto-locks resolved issues after 90 days
- **`github-issues.ts`**: Issue templates and bot configurations

### Scripts (Generated for Provider Repos)

**`src/scripts/check-for-upgrades.ts`**
Compares current provider version against Terraform Registry to detect new releases.

**`src/scripts/should-release.ts`**
Determines if a release is needed by comparing `version.json` against the last git tag.

### Key Workflow Patterns

**Provider Update Flow:**
1. `provider-upgrade` workflow runs daily (randomized cron between 3-4am)
2. Checks Terraform Registry for new provider version
3. If available, runs `yarn fetch` (which executes `cdktf get`)
4. Adds copyright headers back (they get nuked by fetch)
5. Creates PR with appropriate semantic commit message (`feat:` for minor, `fix:` for patch)
6. Auto-approve and auto-merge labels trigger automated merge

**Release Flow:**
1. Build workflow runs on every push
2. `should-release.js` compares `src/version.json` against git tags
3. If changes detected, release workflow publishes to all package registries
4. Custom `unconditional-bump` task sets version in package.json for Go docs

**Memory Management:**
- Default GitHub runners: 7GB (heap limit ~6.6GB)
- Custom runners: 32GB (heap limit ~31.7GB)
- Set via `NODE_OPTIONS` environment variable: `--max-old-space-size`

## Important Configuration Details

### GitHub Actions Pinning
All GitHub Actions use pinned commit SHAs (not version tags) for security. Update both:
1. `.projenrc.ts` (this repo)
2. `src/index.ts` (for generated provider repos)

### JSII and TypeScript Versions
**CRITICAL**: JSII and TypeScript must use the same major/minor version range.
- Example: `jsiiVersion: "~5.8.0"` requires `typescriptVersion: "~5.8.0"`
- This constraint exists in both `.projenrc.ts` and provider project options

### Package Naming Convention
Generated packages follow this pattern:
- **npm**: `@{namespace}/provider-{providerName}`
- **Python**: `{namespace}-provider-{providerName}`
- **Go**: `github.com/{githubNamespace}/cdktn-provider-{providerName}-go`

### For Future

- **Maven**: `{mavenOrg}.providers.{providerName}`
- **NuGet**: `{NuGetOrg}.Providers.{ProviderName}`

Special cases: `null` and `random` providers get `_provider` suffix in Maven to avoid keyword conflicts.

## Deprecation Workflow

When `isDeprecated: true`:
- Disables dependency upgrades
- Skips provider upgrade workflow
- Adds deprecation notice to README
- Release workflow includes deprecation step for package managers
- Go packages get deprecation comment in generated code

## Testing Strategy

Tests use snapshot testing via `synthSnapshot()` helper:
- Generates a full Projen project in memory
- Captures all generated files
- Compares against committed snapshots
- Update snapshots: `npm test -- -u`

Key test scenarios:
- Minimal configuration
- Custom GitHub runners
- Deprecated providers
- Various version range syntaxes
- Maven/NuGet org overrides

## Making Changes

1. **Modify `.projenrc.ts` or `src/` files** - Never edit generated files directly
2. **Run `npx projen`** - Regenerates all project files
3. **Run tests** - `npm test`
4. **Validate workflows** - Happens automatically in post-compile, checks YAML against schemas
5. **Test in a provider repo** - Use `yarn link` for local testing
6. **Commit and release** - Auto-release on main branch (if not paths-ignored)

## Fork-Specific Context

This fork (cdktn.io) continues development after HashiCorp's sunset. With a Phased approach.
- Uses `cdktf` and `cdktf-cli` packages instead of `cdktf` until the core project rename has completed, the priority is to restart the provider binding generation first.
- In the near future, will Use `cdktn` and `cdktn-cli` packages instead of `cdktf`
- Default `githubNamespace` updated to "cdktn-io" due to Hashicorp maintaining copyright over original cdtkf/cdk.tf/terraform-cdk orgs, repositories and package names.
- Maintain support custom namespaces for organizations wanting to publish their own provider bindings

## Common Gotchas

- **Don't manually edit workflow YAML files** - Modify the Projen components in `src/` instead
- **Provider repos need secrets** - NPM_TOKEN, TWINE_*, MAVEN_*, GH_TOKEN for publishing (this is managed by a separate project called the "cdkn-repository-manager")
- **Fetch nukes src/ directory** - Copyright headers must be re-added after `cdktf get`
- **version.json has exactly one entry** - Multi-provider projects are not supported
- **Release task is conditional** - Controlled by `should-release.js`, use `unconditional-release` to force
