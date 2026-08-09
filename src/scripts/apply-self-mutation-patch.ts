/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { FileBase, FileBaseOptions } from "projen";
import { NodeProject } from "projen/lib/javascript";

export interface ApplySelfMutationPatchScriptFileOptions
  extends FileBaseOptions {}

export class ApplySelfMutationPatchScriptFile extends FileBase {
  protected readonly options: ApplySelfMutationPatchScriptFileOptions;

  constructor(
    project: NodeProject,
    options: ApplySelfMutationPatchScriptFileOptions
  ) {
    super(project, "scripts/apply-self-mutation-patch.sh", options);
    this.options = options;
  }

  protected synthesizeContent(): string | undefined {
    return `#!/usr/bin/env bash
# Copyright (c) HashiCorp, Inc.
# SPDX-License-Identifier: MPL-2.0
#
# Applies the self-mutation patch produced by the build job. A plain
# \`git apply\` is tried first; it fails deterministically once the patch
# exceeds git's hard ~1GiB input limit (e.g. a birth-commit docs/ tree with
# tens of thousands of files), so on failure we fall back to splitting the
# patch into chunks -- only on lines starting with "diff --git " so no
# individual file diff is ever cut in half -- and applying them sequentially.
# Any real failure must fail the job loudly: never fall through to the
# "empty patch" message on a genuine apply error.
set -euo pipefail

PATCH_FILE="\$1"
CHUNK_MAX_BYTES=536870912 # 512MiB, comfortably under git's ~1GiB apply limit

if [ ! -s "\$PATCH_FILE" ]; then
  echo "Empty patch. Skipping."
  exit 0
fi

if git apply "\$PATCH_FILE" 2>/tmp/apply-self-mutation-patch.err; then
  cat /tmp/apply-self-mutation-patch.err >&2
  exit 0
fi

echo "Plain 'git apply' failed, falling back to chunked apply:"
cat /tmp/apply-self-mutation-patch.err

CHUNK_DIR="\$(mktemp -d)"
trap 'rm -rf "\$CHUNK_DIR"' EXIT

python3 - "\$PATCH_FILE" "\$CHUNK_DIR" "\$CHUNK_MAX_BYTES" <<'PYEOF'
import sys

patch_file, chunk_dir, chunk_max_bytes = sys.argv[1], sys.argv[2], int(sys.argv[3])

# Binary mode end to end: the patch may contain non-UTF-8 bytes, and text
# mode's newline translation would corrupt CRLF content. Lines are streamed
# straight into the open chunk file so memory stays flat regardless of size.
out = None
out_bytes = 0
chunk_index = 0
with open(patch_file, "rb") as f:
    for line in f:
        if out is None or (
            line.startswith(b"diff --git ") and out_bytes + len(line) > chunk_max_bytes
        ):
            if out:
                out.close()
            out = open(f"{chunk_dir}/{chunk_index:04d}.patch", "wb")
            chunk_index += 1
            out_bytes = 0
        out.write(line)
        out_bytes += len(line)
if out:
    out.close()
PYEOF

shopt -s nullglob
chunks=("\$CHUNK_DIR"/*.patch)
shopt -u nullglob

if [ \${#chunks[@]} -eq 0 ]; then
  echo "Chunking produced no output for a non-empty patch -- treating as a real failure."
  exit 1
fi

echo "Applying \${#chunks[@]} chunk(s) sequentially..."
for chunk in "\${chunks[@]}"; do
  if ! git apply "\$chunk" 2>/tmp/apply-self-mutation-patch.err; then
    echo "Failed to apply chunk: \$chunk"
    cat /tmp/apply-self-mutation-patch.err
    exit 1
  fi
done
`;
  }
}
