#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { resolveSafeExistingFile, signedManifestPayload } from "./release-identity.mjs";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value && !value.startsWith("--")) {
      values.set(key, value);
      index += 1;
    }
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.get("root") || process.cwd());
const source = resolveSafeExistingFile(args.get("manifest"), { root });
if (!source.ok) {
  console.error(`manifest payload render failed: ${source.reason}`);
  process.exit(1);
}
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(source.path, "utf8"));
} catch (_error) {
  console.error("manifest payload render failed: invalid JSON");
  process.exit(1);
}
const payload = signedManifestPayload(manifest);
const output = args.get("output");
if (output) {
  const resolvedOutput = path.resolve(root, output);
  const relative = path.relative(root, resolvedOutput);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    console.error("manifest payload render failed: output must be a new file within root");
    process.exit(1);
  }
  if (fs.existsSync(resolvedOutput)) {
    console.error("manifest payload render failed: output already exists");
    process.exit(1);
  }
  fs.writeFileSync(resolvedOutput, payload, { flag: "wx" });
} else {
  process.stdout.write(payload);
}
