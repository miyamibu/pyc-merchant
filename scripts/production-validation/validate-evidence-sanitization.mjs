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

function buildSecretNeedles() {
  const needles = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!String(value || "").trim()) continue;
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
