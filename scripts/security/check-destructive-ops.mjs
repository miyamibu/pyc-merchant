import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_SCAN_ROOTS = ["src", "scripts", "tests", "migrations", "public"];
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
  // The scanner's own negative-test file intentionally embeds destructive
  // statement fixtures; production surfaces remain fully scanned.
  "tests/security/destructive-ops.test.mjs",
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
  "refund_funding_lineage",
  "refund_funding_allocations",
  "refund_funding_sweeps",
  "refund_funding_allocation_parts",
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

export const TEST_ONLY_DELETE_TABLES = new Set([
  "chain_dead_letters",
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
  {
    id: "node.fs-protected-delete",
    regex: /\brm(?:Sync|dirSync)?\s*\([^)\n]*(?:runtime\/?|data\/?|docs\/production\/evidence\/?|deploy\/nginx\/certs\/?|\.env(?:\.production)?\b|[^\s"'`(),]+\.(?:db|sqlite|sqlite3)\b)/i,
    message: "fs delete call targets a protected path or DB artifact",
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

function classifyDeleteStatement({ rootDir, filePath, tableName, guardText, excerpt, lineNumber }) {
  const findings = [];
  const relativePath = normalizeRelativePath(rootDir, filePath);

  if (relativePath.startsWith("tests/") && TEST_ONLY_DELETE_TABLES.has(tableName)) {
    return findings;
  }

  if (ALLOWED_DELETE_RULES.has(tableName)) {
    const allowRule = ALLOWED_DELETE_RULES.get(tableName);
    const hasAllGuards = allowRule.guards.every((guard) => guard.test(guardText));
    if (!hasAllGuards) {
      findings.push(
        buildFinding({
          rootDir,
          filePath,
          lineNumber,
          ruleId: "sql.delete.allowlist-guard-missing",
          message: `DELETE FROM ${tableName} is only allowed with explicit guard fragments (${allowRule.reason})`,
          excerpt,
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
        excerpt,
      })
    );
    return findings;
  }

  findings.push(
    buildFinding({
      rootDir,
      filePath,
      lineNumber,
      ruleId: "sql.delete.unclassified-table",
      message: `DELETE FROM ${tableName} is not covered by an explicit safe cleanup rule`,
      excerpt,
    })
  );

  return findings;
}

const DANGEROUS_MULTILINE_RULES = [
  { id: "sql.drop-table", regex: /\bdrop\s+table\b/gi },
  { id: "sql.truncate", regex: /\btruncate\b/gi },
];

function deleteStatementWindow(content, match) {
  const start = match.index;
  const searchStart = start + match[0].length;
  const terminators = [";", "`", "\"", "'"];
  let end = content.length;

  for (const terminator of terminators) {
    const candidate = content.indexOf(terminator, searchStart);
    if (candidate !== -1 && candidate < end) end = candidate + 1;
  }

  if (end === content.length) {
    const lineEnd = content.indexOf("\n", searchStart);
    if (lineEnd !== -1) end = lineEnd;
  }

  return content
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ");
}

export function scanMultilineStatements(rootDir, filePath, content) {
  // Match directly against the original content: every multiline rule uses
  // \s+/\s* (or explicit characters), so statements spanning lines are still
  // detected, while match.index stays aligned with the original line offsets
  // below. Collapsing whitespace first would shift indices and misattribute
  // reported line numbers whenever preceding lines contain blank or indented
  // content.
  const lineOffsets = [0];
  for (const newline of content.matchAll(/\n/g)) {
    lineOffsets.push(newline.index + 1);
  }
  const lineOf = (index) => {
    let low = 0;
    let high = lineOffsets.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineOffsets[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  const findings = [];

  const deleteRe = /\bdelete\s+from\s+[`"[]?([a-zA-Z_][\w]*)[`"\]]?/gi;
  for (const match of content.matchAll(deleteRe)) {
    const statementText = deleteStatementWindow(content, match);
    findings.push(
      ...classifyDeleteStatement({
        rootDir,
        filePath,
        tableName: String(match[1] || "").toLowerCase(),
        guardText: statementText,
        excerpt: statementText,
        lineNumber: lineOf(match.index),
      })
    );
  }

  for (const rule of DANGEROUS_MULTILINE_RULES) {
    for (const match of content.matchAll(rule.regex)) {
      findings.push(
        buildFinding({
          rootDir,
          filePath,
          lineNumber: lineOf(match.index),
          ruleId: rule.id,
          message: rule.id === "sql.drop-table" ? "DROP TABLE detected" : "TRUNCATE detected",
          excerpt: match[0],
        })
      );
    }
  }

  const dynamicConcatRe = /\bdelete\s+from\b["'`]\s*\+\s*[a-zA-Z_$]|\bdelete\s+from\s*\$\{/gi;
  for (const match of content.matchAll(dynamicConcatRe)) {
    findings.push(
      buildFinding({
        rootDir,
        filePath,
        lineNumber: lineOf(match.index),
        ruleId: "sql.delete.dynamic-concat",
        message: "dynamically concatenated DELETE statement detected; table names must be static and allowlisted",
        excerpt: match[0],
      })
    );
  }

  return findings;
}

export function scanFile(rootDir, filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  const findings = [];
  const seen = new Set();

  const pushUnique = (finding) => {
    const key = `${normalizeRelativePath(rootDir, filePath)}:${finding.line}:${finding.ruleId}:${finding.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;

    for (const rule of DANGEROUS_LINE_RULES) {
      if (rule.regex.test(line)) {
        pushUnique(
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
  }

  for (const finding of scanMultilineStatements(rootDir, filePath, content)) {
    pushUnique(finding);
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
