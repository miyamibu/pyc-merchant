import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SCAN_ROOTS = ["src", "scripts", "tests", "migrations"];
export const DEFAULT_DIRECT_FILES = ["package.json"];
export const SCANNABLE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".jsx",
  ".tsx",
  ".sh",
  ".bash",
  ".sql",
  ".json",
]);

export const PROTECTED_PATH_PREFIXES = [
  "runtime/",
  "data/",
  "docs/production/evidence/",
  "deploy/nginx/certs/",
];

export const SELF_EXCLUDED_RELATIVE_PATHS = new Set([
  "scripts/security/check-destructive-ops.mjs",
]);

export const PROTECTED_DELETE_TABLES = new Set([
  "invoices",
  "payment_events",
  "payment_attempts",
  "checkout_sessions",
  "payment_sessions",
  "provider_payment_sessions",
  "provider_payment_events",
  "provider_settlements",
  "provider_settlement_allocations",
  "payment_reconciliation_links",
  "review_cases",
  "refund_requests",
  "settlements",
  "settlement_exports",
  "settlement_export_runs",
  "settlement_export_rows",
  "audit_logs",
  "receive_addresses",
  "accounting_sync_records",
  "accounting_sync_runs",
]);

export const ALLOWED_DELETE_RULES = new Map([
  [
    "rate_limit_events",
    {
      guards: [/\bwhere\b/i, /created_at_unix_ms/i],
      reason: "expired non-business runtime records only",
    },
  ],
  [
    "idempotency_records",
    {
      guards: [/\bwhere\b/i, /expires_at/i],
      reason: "expired non-business runtime records only",
    },
  ],
  [
    "service_replay_guards",
    {
      guards: [/\bwhere\b/i, /expires_at/i],
      reason: "expired non-business runtime records only",
    },
  ],
]);

const DANGEROUS_LINE_RULES = [
  {
    id: "shell.rm-rf",
    regex: /\brm\s+-rf\b/,
    message: "dangerous recursive delete command detected",
  },
  {
    id: "shell.find-delete",
    regex: /\bfind\b[^\n]*\s-delete\b/,
    message: "find -delete detected",
  },
  {
    id: "git.clean",
    regex: /\bgit\s+clean\b/,
    message: "git clean detected",
  },
  {
    id: "git.reset-hard",
    regex: /\bgit\s+reset\s+--hard\b/,
    message: "git reset --hard detected",
  },
  {
    id: "docker.compose.down-v",
    regex: /\bdocker\s+compose\s+down\s+-v\b/,
    message: "docker compose down -v detected",
  },
  {
    id: "sql.drop-table",
    regex: /\bdrop\s+table\b/i,
    message: "DROP TABLE detected",
  },
  {
    id: "sql.truncate",
    regex: /\btruncate\b/i,
    message: "TRUNCATE detected",
  },
  {
    id: "shell.protected-path-delete",
    regex: /\brm\b[^\n]*(?:runtime\/?|data\/?|docs\/production\/evidence\/?|deploy\/nginx\/certs\/?|\.env(?:\.production)?\b|[^\s"'`]+\.(?:db|sqlite|sqlite3)\b)/i,
    message: "delete command targets a protected path or DB artifact",
  },
];

function normalizeRelativePath(rootDir, candidatePath) {
  return path.relative(rootDir, candidatePath).split(path.sep).join("/");
}

function isProtectedPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized === ".env" || normalized === ".env.production") return true;
  if (/\.env(\..+)?$/i.test(path.basename(normalized))) return true;
  if (/\.(db|sqlite|sqlite3)$/i.test(normalized)) return true;
  return PROTECTED_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function shouldSkipPath(rootDir, candidatePath) {
  const relativePath = normalizeRelativePath(rootDir, candidatePath);
  if (SELF_EXCLUDED_RELATIVE_PATHS.has(relativePath)) return true;
  return isProtectedPath(relativePath);
}

function shouldDescendDirectory(rootDir, directoryPath) {
  const baseName = path.basename(directoryPath);
  if (baseName === "node_modules" || baseName === ".git") return false;
  return !shouldSkipPath(rootDir, directoryPath);
}

function isScannableFile(candidatePath) {
  return SCANNABLE_EXTENSIONS.has(path.extname(candidatePath).toLowerCase());
}

function walkDirectory(rootDir, directoryPath, files) {
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      if (shouldDescendDirectory(rootDir, fullPath)) {
        walkDirectory(rootDir, fullPath, files);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    if (shouldSkipPath(rootDir, fullPath)) continue;
    if (!isScannableFile(fullPath)) continue;
    files.push(fullPath);
  }
}

export function discoverScanFiles(rootDir, options = {}) {
  const scanRoots = options.scanRoots || DEFAULT_SCAN_ROOTS;
  const directFiles = options.directFiles || DEFAULT_DIRECT_FILES;
  const discovered = [];

  for (const relativeFile of directFiles) {
    const fullPath = path.join(rootDir, relativeFile);
    if (!fs.existsSync(fullPath)) continue;
    if (shouldSkipPath(rootDir, fullPath)) continue;
    discovered.push(fullPath);
  }

  for (const relativeRoot of scanRoots) {
    const fullPath = path.join(rootDir, relativeRoot);
    if (!fs.existsSync(fullPath)) continue;
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (shouldDescendDirectory(rootDir, fullPath)) {
        walkDirectory(rootDir, fullPath, discovered);
      }
      continue;
    }
    if (stat.isFile() && !shouldSkipPath(rootDir, fullPath) && isScannableFile(fullPath)) {
      discovered.push(fullPath);
    }
  }

  return [...new Set(discovered)].sort((left, right) => left.localeCompare(right));
}

function buildFinding({ rootDir, filePath, lineNumber, ruleId, message, excerpt }) {
  return {
    file: normalizeRelativePath(rootDir, filePath),
    line: lineNumber,
    ruleId,
    message,
    excerpt: excerpt.trim(),
  };
}

function scanLineForDeleteStatements(rootDir, filePath, line, lineNumber) {
  const findings = [];
  const match = line.match(/\bdelete\s+from\s+[`"[]?([a-zA-Z_][\w]*)[`"\]]?/i);
  if (!match) return findings;
  const tableName = String(match[1] || "").toLowerCase();

  if (ALLOWED_DELETE_RULES.has(tableName)) {
    const allowRule = ALLOWED_DELETE_RULES.get(tableName);
    const hasAllGuards = allowRule.guards.every((guard) => guard.test(line));
    if (!hasAllGuards) {
      findings.push(
        buildFinding({
          rootDir,
          filePath,
          lineNumber,
          ruleId: "sql.delete.allowlist-guard-missing",
          message: `DELETE FROM ${tableName} is only allowed with explicit guard fragments (${allowRule.reason})`,
          excerpt: line,
        })
      );
    }
    return findings;
  }

  if (PROTECTED_DELETE_TABLES.has(tableName)) {
    findings.push(
      buildFinding({
        rootDir,
        filePath,
        lineNumber,
        ruleId: "sql.delete.protected-table",
        message: `DELETE FROM ${tableName} targets protected business/audit/settlement data`,
        excerpt: line,
      })
    );
  }

  return findings;
}

export function scanFile(rootDir, filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const findings = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;

    for (const rule of DANGEROUS_LINE_RULES) {
      if (rule.regex.test(line)) {
        findings.push(
          buildFinding({
            rootDir,
            filePath,
            lineNumber,
            ruleId: rule.id,
            message: rule.message,
            excerpt: line,
          })
        );
      }
    }

    findings.push(...scanLineForDeleteStatements(rootDir, filePath, line, lineNumber));
  }

  return findings;
}

export function scanWorkspace(rootDir, options = {}) {
  const scannedFiles = discoverScanFiles(rootDir, options);
  const findings = [];
  for (const filePath of scannedFiles) {
    findings.push(...scanFile(rootDir, filePath));
  }
  return {
    rootDir,
    scannedFiles: scannedFiles.map((filePath) => normalizeRelativePath(rootDir, filePath)),
    findings,
  };
}

function formatFindings(findings) {
  return findings
    .map((finding) => `${finding.file}:${finding.line} [${finding.ruleId}] ${finding.message}\n  ${finding.excerpt}`)
    .join("\n");
}

function parseCliRoot(argv) {
  const rootIndex = argv.indexOf("--root");
  if (rootIndex === -1) return process.cwd();
  const value = argv[rootIndex + 1];
  if (!value) {
    throw new Error("--root requires a directory path");
  }
  return path.resolve(value);
}

export function main(argv = process.argv.slice(2)) {
  const rootDir = parseCliRoot(argv);
  const result = scanWorkspace(rootDir);
  if (result.findings.length > 0) {
    console.error("DESTRUCTIVE_OPS_CHECK_FAILED");
    console.error(formatFindings(result.findings));
    process.exitCode = 1;
    return;
  }
  console.log(
    JSON.stringify(
      {
        ok: true,
        scanned_file_count: result.scannedFiles.length,
      },
      null,
      2
    )
  );
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath && entryPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error("DESTRUCTIVE_OPS_CHECK_FAILED");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
