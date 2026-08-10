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
    super(project, "scripts/apply-self-mutation-patch.js", options);
    this.options = options;
  }

  protected synthesizeContent(): string | undefined {
    return `
/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// git apply has a hard ~1GiB input limit, so a patch above it (e.g. a birth
// commit with tens of thousands of docs files) can only be applied in pieces.
// 512MiB keeps every chunk comfortably below that limit; the env var override
// exists so tests can exercise the chunked path without multi-GiB fixtures.
const CHUNK_MAX_BYTES =
  Number.parseInt(process.env.APPLY_PATCH_CHUNK_MAX_BYTES || "", 10) ||
  536870912;

// A chunk boundary is a "diff --git " marker at the start of a line, so an
// individual file diff is never cut in half.
const BOUNDARY = Buffer.from("\\ndiff --git ");
const READ_SIZE = 1024 * 1024;

const patchFile = process.argv[2];
if (!patchFile) {
  console.error("Usage: apply-self-mutation-patch.js <patch-file>");
  process.exit(1);
}

// A nonexistent patch file is a deliberate skip (matching the previous
// \`[ ! -s ]\` behavior); a missing argv above is a hard error. Any other
// stat failure must fail loudly rather than masquerade as an empty patch.
let patchSize = 0;
try {
  patchSize = fs.statSync(patchFile).size;
} catch (e) {
  if (e.code !== "ENOENT") {
    throw e;
  }
  patchSize = 0;
}
if (patchSize === 0) {
  console.log("Empty patch. Skipping.");
  process.exit(0);
}

const plain = gitApply(patchFile);
if (plain.ok) {
  process.stderr.write(plain.stderr);
  process.exit(0);
}

console.log("Plain 'git apply' failed, falling back to chunked apply:");
process.stderr.write(plain.stderr);
process.exit(chunkedApply(patchFile, patchSize));

// Any real failure must fail the job loudly: never fall through to the
// "empty patch" message on a genuine apply error.
function chunkedApply(file, size) {
  const chunkDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "apply-self-mutation-patch-")
  );
  try {
    const chunks = writeChunks(file, size, chunkDir);
    if (chunks.length === 0) {
      console.error(
        "Chunking produced no output for a non-empty patch -- treating as a real failure."
      );
      return 1;
    }
    console.log("Applying " + chunks.length + " chunk(s) sequentially...");
    for (const chunk of chunks) {
      const res = gitApply(chunk);
      process.stderr.write(res.stderr);
      if (!res.ok) {
        console.error("Failed to apply chunk: " + chunk);
        return 1;
      }
    }
    return 0;
  } finally {
    fs.rmSync(chunkDir, { recursive: true, force: true });
  }
}

function gitApply(file) {
  const res = spawnSync("git", ["apply", file], {
    stdio: ["ignore", "inherit", "pipe"],
  });
  const stderr = res.stderr || Buffer.alloc(0);
  if (res.error) {
    return {
      ok: false,
      stderr: Buffer.concat([stderr, Buffer.from(String(res.error) + "\\n")]),
    };
  }
  return { ok: res.status === 0, stderr };
}

function writeChunks(file, size, chunkDir) {
  const fd = fs.openSync(file, "r");
  try {
    // Greedy: fill a chunk with whole file diffs until the next one would push
    // it past the limit. A single file diff larger than the limit stays whole.
    const bounds = findFileDiffStarts(fd, size).concat([size]);
    const chunks = [];
    let start = 0;
    for (let i = 1; i < bounds.length; i++) {
      if (bounds[i] - start > CHUNK_MAX_BYTES && bounds[i - 1] > start) {
        const end = bounds[i - 1];
        chunks.push(writeRange(fd, start, end, chunkDir, chunks.length));
        start = end;
      }
    }
    chunks.push(writeRange(fd, start, size, chunkDir, chunks.length));
    return chunks;
  } finally {
    fs.closeSync(fd);
  }
}

// Raw bytes end to end -- no readline, no string decoding of patch content:
// Node strings are UTF-8 lossy (a latin-1 0xe9 would round-trip as U+FFFD) and
// would mangle lone surrogates, while the patch must be reproduced byte-exact.
function findFileDiffStarts(fd, size) {
  const starts = [0];
  const overlap = BOUNDARY.length - 1;
  const buf = Buffer.allocUnsafe(READ_SIZE + overlap);
  let carry = 0; // bytes kept from the previous read at buf[0..carry)
  let bufStart = 0; // absolute file offset of buf[0]
  let pos = 0;
  while (pos < size) {
    const read = fs.readSync(fd, buf, carry, READ_SIZE, pos);
    if (read === 0) break;
    pos += read;
    const len = carry + read;
    const hay = buf.subarray(0, len);
    let from = 0;
    for (;;) {
      const found = hay.indexOf(BOUNDARY, from);
      if (found === -1) break;
      starts.push(bufStart + found + 1); // the marker itself, not the newline
      from = found + 1;
    }
    // Carry the last BOUNDARY.length - 1 bytes so a marker split across two
    // reads is still found exactly once.
    const keep = Math.min(len, overlap);
    buf.copy(buf, 0, len - keep, len);
    bufStart += len - keep;
    carry = keep;
  }
  return starts;
}

function writeRange(fd, start, end, chunkDir, index) {
  const file = path.join(chunkDir, String(index).padStart(4, "0") + ".patch");
  const out = fs.openSync(file, "w");
  try {
    const buf = Buffer.allocUnsafe(READ_SIZE);
    let pos = start;
    while (pos < end) {
      const read = fs.readSync(fd, buf, 0, Math.min(READ_SIZE, end - pos), pos);
      if (read === 0) break;
      let written = 0;
      while (written < read) {
        written += fs.writeSync(out, buf, written, read - written);
      }
      pos += read;
    }
  } finally {
    fs.closeSync(out);
  }
  return file;
}
`;
  }
}
