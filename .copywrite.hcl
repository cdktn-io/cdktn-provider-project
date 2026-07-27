schema_version = 1

project {
  license        = "MPL-2.0"
  copyright_year = 2020

  # (OPTIONAL) A list of globs that should not have copyright/license headers.
  # Supports doublestar glob patterns for more flexibility in defining which
  # files or folders should be ignored
  header_ignore = [
    # "vendors/**",
    # "**autogen**",
    "**/node_modules/**",
    "dist/**",
    # Both are projen-owned and rewritten from scratch on every synth. copywrite
    # does header .yaml files, so without these it adds a header that the next
    # `projen` strips, and CI's copywrite step re-adds -- permanent self-mutation
    # churn. (.lock is not a recognised extension, so pnpm-lock.yaml is only at
    # risk once renamed; kept for clarity.)
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
  ]
}
