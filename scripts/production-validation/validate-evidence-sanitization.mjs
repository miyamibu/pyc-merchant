#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function walkFiles(dirPath) {
  const results = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath));
      continue;
    }
    if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const [key, inlineValue] = token.split("=", 2);
    if (inlineValue != null) {
      args.set(key.slice(2), inlineValue);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args.set(key.slice(2), next);
      i += 1;
      continue;
    }
    args.set(key.slice(2), "true");
  }
  return args;
}

function summarizeViolations(violations) {
  return {
    ok: violations.length === 0,
    generated_at: new Date().toISOString(),
    violation_count: violations.length,
    violations,
  };
}

function validateManifest(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const required = [
    "release_id",
    "commit_sha",
    "artifact_storage_ref",
    "artifact_hashes",
    "external_statuses",
    "reviewer_refs",
    "approver_refs",
    "signed_minutes_ref",
    "sbom_ref",
    "image_scan_ref",
    "generated_at",
  ];
  const violations = [];
  for (const key of required) {
    if (manifest[key] == null || manifest[key] === "") violations.push({ file: path.relative(process.cwd(), manifestPath), reason: `missing_${key}` });
  }
  for (const key of ["EXT-001", "EXT-002", "EXT-003", "EXT-004"]) {
    if (!["missing", "pending", "fail", "pass"].includes(String(manifest.external_statuses?.[key] || ""))) {
      violations.push({ file: path.relative(process.cwd(), manifestPath), reason: `invalid_${key}_status` });
    }
  }
  const serialized = JSON.stringify(manifest);
  if (/authorization|bearer|cookie|private[_-]?key|seed phrase|mnemonic|sse_token/i.test(serialized)) {
    violations.push({ file: path.relative(process.cwd(), manifestPath), reason: "manifest_contains_sensitive_material" });
  }
  return violations;
}

function buildSecretNeedles() {
  const needles = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!String(value || "").trim()) continue;
    if (/^(?:APPROVED_JPYC_)?TOKEN_CONTRACT$/i.test(key)) continue;
    if (/(?:secret|token|cookie)/i.test(key)) {
      needles.push({ key, value: String(value) });
    }
  }
  return needles;
}

function containsSuspiciousGenericPattern(content) {
  return [
    /authorization:\s*bearer\s+[a-z0-9._-]+/i,
    /set-cookie:/i,
    /cookie:\s*[^=\s]+=.+/i,
    /sse_token=[^&\s]+/i,
  ].some((pattern) => pattern.test(content));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = args.get("manifest") ? path.resolve(process.cwd(), args.get("manifest")) : null;
  if (manifestPath) {
    const summary = summarizeViolations(validateManifest(manifestPath));
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) process.exit(1);
    return;
  }
  const evidenceDir = path.resolve(process.cwd(), String(args.get("evidence-dir") || args.get("dir") || ""));
  if (!evidenceDir || !fs.existsSync(evidenceDir)) {
    console.error(`evidence directory not found: ${evidenceDir}`);
    process.exit(1);
  }

  const secretNeedles = buildSecretNeedles();
  const violations = [];
  for (const filePath of walkFiles(evidenceDir)) {
    const relativePath = path.relative(process.cwd(), filePath);
    const content = fs.readFileSync(filePath, "utf8");

    if (containsSuspiciousGenericPattern(content)) {
      violations.push({
        file: relativePath,
        reason: "generic_token_or_cookie_pattern",
      });
      continue;
    }

    const leaked = secretNeedles.find(({ value }) => value.length >= 12 && content.includes(value));
    if (leaked) {
      violations.push({
        file: relativePath,
        reason: "env_secret_leaked",
        env_key: leaked.key,
      });
    }
  }

  const summary = summarizeViolations(violations);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) {
    process.exit(1);
  }
}

main();
