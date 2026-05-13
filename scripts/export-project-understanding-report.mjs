#!/usr/bin/env node

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const PROJECT_ROOT = process.cwd();
const TZ = "Asia/Tokyo";
const REPORT_TITLE = "JPYC Merchant Ops / Settlement Layer 完全プロジェクト把握レポート";
const GENERATOR = "Codex GPT-5";

const EXCLUDED_DIR_PREFIXES = [
  ".git/",
  "node_modules/",
  "data/",
  "runtime/",
];

const SENSITIVE_EXCLUDE_RULES = [
  {
    name: "real_env",
    reason: "実値の環境変数ファイル",
    test: (relPath) => relPath === ".env" || /^\.env\.(?!example$|production\.example$)/i.test(path.basename(relPath)),
  },
  {
    name: "db_file",
    reason: "DBファイル",
    test: (relPath) => /(?:\.db|\.sqlite|\.sqlite3|\.db-wal|\.db-shm|\.wal|\.shm)$/i.test(relPath),
  },
  {
    name: "private_key",
    reason: "秘密鍵/証明書秘密鍵の可能性があるファイル",
    test: (relPath) => /(?:^|\/)(?:id_rsa|id_ed25519|.*private.*key.*)($|\.)/i.test(relPath) || /\.(?:key|p12|pfx)$/i.test(relPath),
  },
  {
    name: "generated_report",
    reason: "本レポート生成物",
    test: (relPath) =>
      relPath.startsWith("deliverables/project_full_understanding_report_")
      || relPath.startsWith("deliverables/project_full_understanding_report_generation_log_"),
  },
];

const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".log", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".conf", ".config", ".env", ".example",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".scss", ".sass", ".less", ".html", ".xml", ".svg",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".sql", ".csv", ".tsv", ".properties", ".gitignore", ".dockerignore",
  ".gitattributes", ".lock", ".sample", ".service", ".conf", ".cfg",
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".bz2", ".xz", ".7z", ".tar",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp4", ".mov", ".avi", ".db", ".sqlite", ".sqlite3", ".wal", ".shm",
  ".p12", ".pfx", ".key", ".crt", ".cer", ".der",
]);

function formatDateInTz(date, timeZone = TZ) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const ymd = `${parts.year}-${parts.month}-${parts.day}`;
  const ymdCompact = `${parts.year}${parts.month}${parts.day}`;
  const timestamp = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  return { ymd, ymdCompact, timestamp };
}

function toPosixRel(absPath) {
  return path.relative(PROJECT_ROOT, absPath).split(path.sep).join("/");
}

async function walkAllFiles(rootDir) {
  const files = [];
  const unreadable = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      unreadable.push({ path: toPosixRel(currentDir), error: String(error.message || error) });
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(currentDir, entry.name);
      const rel = toPosixRel(abs);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        files.push(rel);
      } else if (entry.isSymbolicLink()) {
        try {
          const stat = await fs.stat(abs);
          if (stat.isDirectory()) {
            stack.push(abs);
          } else if (stat.isFile()) {
            files.push(rel);
          }
        } catch (error) {
          unreadable.push({ path: rel, error: String(error.message || error) });
        }
      }
    }
  }
  files.sort((a, b) => a.localeCompare(b));
  return { files, unreadable };
}

function findExcludedDir(relPath) {
  for (const prefix of EXCLUDED_DIR_PREFIXES) {
    if (relPath === prefix.slice(0, -1) || relPath.startsWith(prefix)) {
      return prefix;
    }
  }
  return null;
}

function findSensitiveExclude(relPath) {
  for (const rule of SENSITIVE_EXCLUDE_RULES) {
    if (rule.test(relPath)) return rule;
  }
  return null;
}

function guessEncoding(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return "UTF-8 BOM";
  }
  return "UTF-8 (推定)";
}

function isProbablyText(relPath, buffer) {
  const ext = path.extname(relPath).toLowerCase();
  const base = path.basename(relPath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(base)) return true;
  if (BINARY_EXTENSIONS.has(ext)) return false;
  if (buffer.includes(0)) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let suspicious = 0;
  for (const byte of sample) {
    const printable = (byte >= 32 && byte <= 126) || byte === 9 || byte === 10 || byte === 13 || byte >= 0x80;
    if (!printable) suspicious += 1;
  }
  return sample.length === 0 || suspicious / sample.length < 0.2;
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function shouldRedactEnvKey(keyRaw) {
  const key = String(keyRaw || "").trim().toUpperCase();
  if (!key) return false;
  const allowList = new Set([
    "TOKEN_CONTRACT",
    "APPROVED_JPYC_TOKEN_CONTRACT",
    "TOKEN_SYMBOL",
    "TOKEN_DECIMALS",
    "CHAIN_ID",
    "REOWN_PROJECT_ID",
    "TERMINAL_CODE",
  ]);
  if (allowList.has(key)) return false;
  const explicit = [
    "APP_SECRET",
    "SERVICE_INGEST_SECRET",
    "METRICS_SECRET",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "API_SECRET",
    "API_KEY",
    "ACCESS_TOKEN",
    "REFRESH_TOKEN",
    "BEARER_TOKEN",
    "COOKIE_SECRET",
    "PASSWORD",
    "DB_PASSWORD",
    "PRIVATE_KEY",
    "TLS_PRIVATE_KEY",
    "MNEMONIC",
    "SEED_PHRASE",
    "SEED",
  ];
  if (explicit.includes(key)) return true;
  if (key.includes("SECRET")) return true;
  if (key.endsWith("_TOKEN") && !key.includes("CONTRACT")) return true;
  if (key.includes("PASSWORD")) return true;
  if (key.includes("PRIVATE_KEY")) return true;
  if (key.includes("MNEMONIC")) return true;
  if (key.includes("SEED")) return true;
  return false;
}

function redactSecrets(content, relPath) {
  let text = String(content);
  let masked = 0;

  const redact = (regex, replacement) => {
    text = text.replace(regex, (...args) => {
      masked += 1;
      return typeof replacement === "function" ? replacement(...args) : replacement;
    });
  };

  redact(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY_BLOCK]");

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const envMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (envMatch) {
      const key = envMatch[1];
      const value = envMatch[2];
      if (shouldRedactEnvKey(key) && value.trim()) {
        lines[i] = `${key}=[REDACTED_SAMPLE_SECRET]`;
        masked += 1;
        continue;
      }
    }

    if (/(?:private[_-]?key|mnemonic|seed[_ ]?phrase|password|bearer token|api[_-]?secret)/i.test(line)) {
      const maybeKeyValue = line.match(/^([^:=]{0,80}(?:private[_-]?key|mnemonic|seed[_ ]?phrase|password|api[_-]?secret)[^:=]{0,80}[:=]\s*)(.+)$/i);
      if (maybeKeyValue) {
        lines[i] = `${maybeKeyValue[1]}[REDACTED]`;
        masked += 1;
      }
    }
  }
  text = lines.join("\n");

  redact(/("(?:access_token|refresh_token|api_key|api_secret|password|private_key|mnemonic|seed_phrase|cookie_secret|bearer_token)"\s*:\s*")([^"]+)(")/gi, (_m, p1, _p2, p3) => `${p1}[REDACTED]${p3}`);
  redact(/(Bearer\s+)([A-Za-z0-9._~+\/-]{8,})/g, (_m, p1) => `${p1}[REDACTED_TOKEN]`);
  redact(/([?&](?:token|access_token|refresh_token|sig|signature)=)([^&\s]+)/gi, (_m, p1) => `${p1}[REDACTED]`);

  return { text, masked };
}

function roleFromPath(relPath) {
  const p = relPath;
  if (p === "README.md") return "プロジェクト概要";
  if (p === "AGENTS.md") return "作業方針";
  if (p.startsWith("docs/")) return "技術/運用ドキュメント";
  if (p.startsWith("src/")) return "サーバー/業務ロジック実装";
  if (p.startsWith("public/")) return "端末UI/公開支払いページ";
  if (p.startsWith("tests/")) return "自動テスト";
  if (p.startsWith("scripts/production-validation/")) return "本番検証スクリプト";
  if (p.startsWith("scripts/deploy/")) return "配備/運用スクリプト";
  if (p.startsWith("deploy/")) return "インフラ設定";
  if (p === "Dockerfile" || p === "docker-compose.prod.yml") return "コンテナ配備定義";
  if (p === "package.json" || p === "package-lock.json") return "依存関係/実行定義";
  return "補助ファイル";
}

function importanceFromPath(relPath) {
  const highSet = new Set([
    "src/server.mjs",
    "src/chain-monitor.mjs",
    "src/payment-logic.mjs",
    "src/wallet-adapter.mjs",
    "src/amounts.mjs",
    "Dockerfile",
    "docker-compose.prod.yml",
    "README.md",
  ]);
  if (highSet.has(relPath)) return "高";
  if (relPath.startsWith("docs/")) {
    if (/docs\/(00|01|02|03|10|11|20|21|30|31|32|33|34|40|41|42|50|60|61|62|70|71|72|73|74|75|90|91|92|93|94|95|96|97|98)/.test(relPath)) {
      return "高";
    }
    return "中";
  }
  if (relPath.startsWith("src/") || relPath.startsWith("public/") || relPath.startsWith("scripts/") || relPath.startsWith("tests/")) {
    return "中";
  }
  return "低";
}

function relatedSectionsFromPath(relPath) {
  const mapping = [
    { test: /^README\.md$/, sections: "1,2,3" },
    { test: /^src\/server\.mjs$/, sections: "4,5,6,7,8,10,11" },
    { test: /^src\/chain-monitor\.mjs$/, sections: "4,5,6,7,8,11,18" },
    { test: /^src\/payment-logic\.mjs$/, sections: "5,6,7" },
    { test: /^src\/wallet-adapter\.mjs$/, sections: "5,8,9" },
    { test: /^src\/amounts\.mjs$/, sections: "6,7" },
    { test: /^public\/terminal\.js$/, sections: "5,9" },
    { test: /^public\/mobile\.js$/, sections: "5,9" },
    { test: /^public\/(terminal|mobile)\.html$/, sections: "9" },
    { test: /^public\/app\.css$/, sections: "9" },
    { test: /^tests\//, sections: "13" },
    { test: /^scripts\/deploy\//, sections: "11" },
    { test: /^scripts\/production-validation\//, sections: "11,13" },
    { test: /^deploy\//, sections: "11" },
    { test: /^docs\/10-/, sections: "12" },
    { test: /^docs\/11-/, sections: "12" },
    { test: /^docs\/30-/, sections: "4" },
    { test: /^docs\/31-/, sections: "7" },
    { test: /^docs\/32-/, sections: "8" },
    { test: /^docs\/33-/, sections: "6" },
    { test: /^docs\/34-/, sections: "6,10" },
    { test: /^docs\/40-/, sections: "9" },
    { test: /^docs\/41-/, sections: "9" },
    { test: /^docs\/42-/, sections: "9" },
    { test: /^docs\/50-/, sections: "5,18" },
    { test: /^docs\/62-/, sections: "5,10" },
    { test: /^docs\/70-/, sections: "11" },
    { test: /^docs\/90-/, sections: "13" },
    { test: /^docs\/91-/, sections: "13,17" },
    { test: /^docs\/92-/, sections: "12,13" },
    { test: /^docs\/production\//, sections: "17" },
  ];
  const item = mapping.find((row) => row.test.test(relPath));
  return item ? item.sections : "14,15";
}

function detectFileKind(relPath, isText) {
  const ext = path.extname(relPath).toLowerCase();
  if (!isText) return "バイナリ";
  if ([".md"].includes(ext)) return "Markdown";
  if ([".js", ".mjs", ".cjs"].includes(ext)) return "JavaScript";
  if ([".html"].includes(ext)) return "HTML";
  if ([".css"].includes(ext)) return "CSS";
  if ([".json"].includes(ext)) return "JSON";
  if ([".sh"].includes(ext)) return "Shell";
  if ([".yml", ".yaml"].includes(ext)) return "YAML";
  if ([".txt", ".log"].includes(ext)) return "Text";
  if (ext) return ext.slice(1).toUpperCase();
  return "Text";
}

function bytesHuman(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n)) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / (1024 ** 2)).toFixed(1)} MB`;
  return `${(n / (1024 ** 3)).toFixed(1)} GB`;
}

function markdownEscapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function chunkArray(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

function buildTree(paths, excludedDirStats) {
  const root = { name: ".", children: new Map(), files: [] };
  for (const relPath of paths) {
    const parts = relPath.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (!node.children.has(part)) {
        node.children.set(part, { name: part, children: new Map(), files: [] });
      }
      node = node.children.get(part);
    }
    node.files.push(parts[parts.length - 1]);
  }

  const lines = ["."];

  const renderNode = (node, prefix) => {
    const dirs = [...node.children.keys()].sort((a, b) => a.localeCompare(b));
    const files = [...node.files].sort((a, b) => a.localeCompare(b));
    const total = dirs.length + files.length;
    let index = 0;
    for (const dirName of dirs) {
      index += 1;
      const last = index === total;
      const connector = last ? "└── " : "├── ";
      lines.push(`${prefix}${connector}${dirName}/`);
      const child = node.children.get(dirName);
      const nextPrefix = `${prefix}${last ? "    " : "│   "}`;
      renderNode(child, nextPrefix);
    }
    for (const fileName of files) {
      index += 1;
      const last = index === total;
      const connector = last ? "└── " : "├── ";
      lines.push(`${prefix}${connector}${fileName}`);
    }
  };

  renderNode(root, "");

  lines.push("");
  lines.push("[除外ディレクトリサマリー]");
  for (const [prefix, stat] of [...excludedDirStats.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`- ${prefix} : ${stat.count} files (理由: ${stat.reason})`);
  }

  return lines.join("\n");
}

function parseApiEndpoints(serverCode) {
  const regex = /app\.(get|post|patch|put|delete)\("([^"]+)"/g;
  const rows = [];
  for (const match of serverCode.matchAll(regex)) {
    rows.push({ method: match[1].toUpperCase(), path: match[2] });
  }
  return rows;
}

function parseTestsWithNames(testFiles, contentMap) {
  const rows = [];
  for (const relPath of testFiles) {
    const content = contentMap.get(relPath)?.text || "";
    const names = [];
    const regex = /(?:test|it)\(\s*["'`]([^"'`]+)["'`]/g;
    for (const match of content.matchAll(regex)) names.push(match[1]);
    rows.push({ relPath, names });
  }
  rows.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return rows;
}

function summarizeTestGuarantee(testNameList) {
  if (!testNameList || testNameList.length === 0) return "テスト定義名の抽出不可";
  const first = testNameList[0];
  if (/late|期限|LATE_PAYMENT/i.test(first)) return "期限後着金を fail-closed で review に送ることを保証";
  if (/refund|返金/i.test(first)) return "返金の二名承認・検証遷移と重複防止を保証";
  if (/wallet|deeplink|mobile/i.test(first)) return "ウォレット導線・フォールバック・顧客UI要件を保証";
  if (/audit|chain/i.test(first)) return "監査チェーン整合と改ざん検知を保証";
  if (/security|guard|dangerous|rate|permission/i.test(first)) return "権限・ガード・公開面のセキュリティ要件を保証";
  if (/settlement|closing|export/i.test(first)) return "日次締め/CSV/会計出力契約を保証";
  return `主に「${first}」を起点に業務ロジック回帰を保証`;
}

function buildImportantFileNotes(existingSet) {
  const entries = [
    // Documentation
    "README.md",
    "docs/00-current-state.md",
    "docs/01-gap-analysis.md",
    "docs/02-executive-summary.md",
    "docs/03-limited-release-overview.md",
    "docs/10-legal-scope.md",
    "docs/11-regulatory-questions.md",
    "docs/20-payment-method-adr.md",
    "docs/21-chain-and-token-spec.md",
    "docs/30-architecture.md",
    "docs/31-db-schema.md",
    "docs/32-api-spec.md",
    "docs/33-state-machine.md",
    "docs/34-idempotency-and-audit.md",
    "docs/40-qr-spec.md",
    "docs/41-mobile-payment-page-spec.md",
    "docs/42-wallet-integration-spec.md",
    "docs/50-chain-monitoring.md",
    "docs/62-refund-policy-and-flow.md",
    "docs/70-infra.md",
    "docs/90-production-validation-plan.md",
    "docs/91-go-no-go-checklist.md",
    "docs/production/BLOCKED_EXTERNAL_VALIDATION.md",

    // Source
    "src/server.mjs",
    "src/chain-monitor.mjs",
    "src/payment-logic.mjs",
    "src/wallet-adapter.mjs",
    "src/amounts.mjs",

    // Frontend
    "public/index.js",
    "public/terminal.js",
    "public/mobile.js",
    "public/app.css",
    "public/terminal.html",
    "public/mobile.html",

    // Deploy/Ops
    "Dockerfile",
    "docker-compose.prod.yml",
    "deploy/nginx/jpyc-payment-terminal.conf",
    "deploy/systemd/jpyc-payment-terminal.service",
    "scripts/deploy/check.sh",
    "scripts/deploy/preflight.sh",
    "scripts/deploy/healthcheck.sh",
    "scripts/deploy/backup-sqlite.sh",
    "scripts/deploy/restore-drill.sh",
    "scripts/smoke-test.mjs",
    "scripts/verify-audit-chain.mjs",
  ];

  const rows = [];
  for (const relPath of entries) {
    rows.push({
      relPath,
      exists: existingSet.has(relPath),
      purpose: roleFromPath(relPath),
      scope: relatedSectionsFromPath(relPath),
      keyPoint: relPath.includes("server.mjs")
        ? "API境界・fail-closedガード・監査ログhash chainの中心実装"
        : relPath.includes("chain-monitor.mjs")
          ? "Polygon監視・dead-letter再試行・checkpoint制御"
          : relPath.includes("payment-logic.mjs")
            ? "金額一致/不足/過入金/期限後判定の純粋ロジック"
            : relPath.includes("wallet-adapter.mjs")
              ? "EIP-681 URI生成とdeeplink/fallback導線"
              : relPath.includes("amounts.mjs")
                ? "整数基準金額変換（浮動小数点不使用）"
                : relPath.includes("mobile.js")
                  ? "顧客向け支払いページのウォレット起動順とコピーfallback"
                  : relPath.includes("terminal.js")
                    ? "店舗向け運用UI（review/refund/settlement連携）"
                    : relPath.includes("Dockerfile") || relPath.includes("compose") || relPath.includes("deploy/")
                      ? "限定店舗実証用の再現可能な配備パック"
                      : relPath.includes("verify-audit-chain")
                        ? "監査ハッシュチェーンの検証ユーティリティ"
                        : relPath.includes("smoke-test")
                          ? "E2E近似の運用フロー回帰検証"
                          : "要求・方針・未検証項目の根拠文書",
      risk: relPath.includes("31-db-schema")
        ? "設計文書にPostgreSQL想定記述があり、現行SQLite実装との差分管理が必要"
        : relPath.includes("BLOCKED_EXTERNAL_VALIDATION")
          ? "未実行項目を埋めないままGO判定すると誤認リスク"
          : relPath.includes(".example")
            ? "サンプル値の本番誤適用リスク"
            : "運用ゲート未設定/手順逸脱時にfail-closedで停止する設計を維持する必要",
      related: relPath.startsWith("src/")
        ? "tests/*, docs/32-api-spec.md, docs/33-state-machine.md"
        : relPath.startsWith("public/")
          ? "tests/frontend-security.test.mjs, docs/41-mobile-payment-page-spec.md"
          : relPath.startsWith("scripts/")
            ? "docs/90-production-validation-plan.md, docs/70-infra.md"
            : "README.md, docs/00-current-state.md",
    });
  }

  return rows;
}

function renderInventoryTable(rows) {
  const header = "| No | path | 種別 | サイズ | ハッシュ | 役割 | 重要度 | 関連章 | PDF内掲載方法 |";
  const sep = "|---:|---|---|---:|---|---|---|---|---|";
  const lines = [header, sep];
  rows.forEach((row, index) => {
    lines.push(
      `| ${index + 1} | ${markdownEscapeCell(row.path)} | ${markdownEscapeCell(row.kind)} | ${markdownEscapeCell(bytesHuman(row.size))} | ${markdownEscapeCell(row.hash || "-")} | ${markdownEscapeCell(row.role)} | ${markdownEscapeCell(row.importance)} | ${markdownEscapeCell(row.sections)} | ${markdownEscapeCell(row.listing)} |`
    );
  });
  return lines.join("\n");
}

function renderApiTable(requiredApis) {
  const lines = [
    "| API | 目的 | 認証 | 入力 | 出力 | 状態遷移影響 | 監査対象 | 重要fail-closed条件 |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const api of requiredApis) {
    lines.push(
      `| ${markdownEscapeCell(api.path)} | ${markdownEscapeCell(api.purpose)} | ${markdownEscapeCell(api.auth)} | ${markdownEscapeCell(api.input)} | ${markdownEscapeCell(api.output)} | ${markdownEscapeCell(api.transition)} | ${markdownEscapeCell(api.audit)} | ${markdownEscapeCell(api.failClosed)} |`
    );
  }
  return lines.join("\n");
}

function renderRiskTable(rows) {
  const lines = [
    "| リスク | 発生条件 | 影響 | 現在の対策 | 残課題 | 優先度 |",
    "|---|---|---|---|---|---|",
  ];
  for (const row of rows) {
    lines.push(
      `| ${markdownEscapeCell(row.risk)} | ${markdownEscapeCell(row.condition)} | ${markdownEscapeCell(row.impact)} | ${markdownEscapeCell(row.current)} | ${markdownEscapeCell(row.remaining)} | ${markdownEscapeCell(row.priority)} |`
    );
  }
  return lines.join("\n");
}

function renderStatusTable(rows) {
  const lines = [
    "| 項目 | 区分 | 根拠 |",
    "|---|---|---|",
  ];
  rows.forEach((row) => {
    lines.push(`| ${markdownEscapeCell(row.item)} | ${markdownEscapeCell(row.status)} | ${markdownEscapeCell(row.evidence)} |`);
  });
  return lines.join("\n");
}

function renderTestTable(rows) {
  const lines = [
    "| テストファイル | 主な保証内容 | 代表テスト名 |",
    "|---|---|---|",
  ];
  for (const row of rows) {
    const sample = row.names.slice(0, 3).join(" / ");
    lines.push(
      `| ${markdownEscapeCell(row.relPath)} | ${markdownEscapeCell(summarizeTestGuarantee(row.names))} | ${markdownEscapeCell(sample || "-")} |`
    );
  }
  return lines.join("\n");
}

function renderImportantFileTable(rows) {
  const lines = [
    "| ファイル | 存在 | 何のためのファイルか | 全体との関係 | 重要な実装/決定 | リスク/注意点 | 関連テスト/文書 |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const row of rows) {
    lines.push(
      `| ${markdownEscapeCell(row.relPath)} | ${row.exists ? "あり" : "欠落"} | ${markdownEscapeCell(row.purpose)} | ${markdownEscapeCell(`章 ${row.scope}`)} | ${markdownEscapeCell(row.keyPoint)} | ${markdownEscapeCell(row.risk)} | ${markdownEscapeCell(row.related)} |`
    );
  }
  return lines.join("\n");
}

function buildPythonRendererScript(pyPath) {
  const script = `
import json
import os
import sys
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

md_path = sys.argv[1]
out_path = sys.argv[2]

pdfmetrics.registerFont(UnicodeCIDFont('HeiseiKakuGo-W5'))
base_font = 'HeiseiKakuGo-W5'
code_font = 'Courier'

with open(md_path, 'r', encoding='utf-8', errors='replace') as f:
    lines = f.read().splitlines()

width, height = A4
margin_x = 36
margin_top = 42
margin_bottom = 44
content_width = width - margin_x * 2

c = canvas.Canvas(out_path, pagesize=A4)
page = 1
y = height - margin_top
in_code = False


def ensure_space(line_height):
    global y, page
    if y - line_height < margin_bottom:
        draw_footer()
        c.showPage()
        page += 1
        y = height - margin_top


def draw_footer():
    c.setFont(base_font, 9)
    c.drawRightString(width - margin_x, 20, f'Page {page}')


def char_wrap(text, font_name, font_size, max_width):
    if text == '':
        return ['']
    out = []
    current = ''
    for ch in text:
        candidate = current + ch
        w = pdfmetrics.stringWidth(candidate, font_name, font_size)
        if w <= max_width or current == '':
            current = candidate
        else:
            out.append(current)
            current = ch
    if current:
        out.append(current)
    return out

for raw in lines:
    line = raw.rstrip('\\\\n')

    if line.startswith(chr(96) * 3) or line.startswith(chr(96) * 4):
        in_code = not in_code
        ensure_space(14)
        c.setFont(code_font if in_code else base_font, 9)
        c.drawString(margin_x, y, line)
        y -= 14
        continue

    if in_code:
        font = code_font
        if any(ord(ch) > 127 for ch in line):
            font = base_font
        size = 8
        lh = 11
    elif line.startswith('# '):
        font = base_font
        size = 16
        lh = 22
        line = line[2:]
    elif line.startswith('## '):
        font = base_font
        size = 14
        lh = 19
        line = line[3:]
    elif line.startswith('### '):
        font = base_font
        size = 12
        lh = 17
        line = line[4:]
    elif line.startswith('|'):
        font = base_font
        size = 8.6
        lh = 11
    else:
        font = base_font
        size = 9.6
        lh = 13.5

    wrapped = char_wrap(line, font, size, content_width)
    if len(wrapped) == 0:
        wrapped = ['']

    for segment in wrapped:
        ensure_space(lh)
        c.setFont(font, size)
        c.drawString(margin_x, y, segment)
        y -= lh

    if line == '':
        ensure_space(6)
        y -= 6

draw_footer()
c.save()

print(json.dumps({'ok': True, 'pages': page, 'pdf_size': os.path.getsize(out_path)}, ensure_ascii=False))
`;
  fssync.writeFileSync(pyPath, script, "utf8");
}

async function main() {
  const now = new Date();
  const dateInfo = formatDateInTz(now, TZ);
  const deliverablesDir = path.join(PROJECT_ROOT, "deliverables");
  await fs.mkdir(deliverablesDir, { recursive: true });

  const markdownPath = path.join(deliverablesDir, `project_full_understanding_report_${dateInfo.ymdCompact}.md`);
  const pdfPath = path.join(deliverablesDir, `project_full_understanding_report_${dateInfo.ymdCompact}.pdf`);
  const generationLogPath = path.join(deliverablesDir, `project_full_understanding_report_generation_log_${dateInfo.ymdCompact}.txt`);

  const { files: allFiles, unreadable: walkUnreadable } = await walkAllFiles(PROJECT_ROOT);

  const excludedDirStats = new Map();
  for (const prefix of EXCLUDED_DIR_PREFIXES) {
    excludedDirStats.set(prefix, {
      count: 0,
      reason: `${prefix.replace(/\/$/, "")} 配下は巨大/生成物のため本文全文収録対象から除外`,
    });
  }

  for (const relPath of allFiles) {
    const excludedDir = findExcludedDir(relPath);
    if (excludedDir) {
      excludedDirStats.get(excludedDir).count += 1;
    }
  }

  const candidateFiles = allFiles.filter((relPath) => !findExcludedDir(relPath));

  const records = [];
  const textAppendixRecords = [];
  const binaryRecords = [];
  const explicitExcludedFiles = [];
  const unreadableFiles = [...walkUnreadable];
  let totalMaskCount = 0;

  for (const relPath of candidateFiles) {
    const absPath = path.join(PROJECT_ROOT, relPath);
    let stat;
    let buffer;
    try {
      stat = await fs.stat(absPath);
      buffer = await fs.readFile(absPath);
    } catch (error) {
      unreadableFiles.push({ path: relPath, error: String(error.message || error) });
      continue;
    }

    const hash = sha256Hex(buffer);
    const sensitiveRule = findSensitiveExclude(relPath);

    if (sensitiveRule) {
      explicitExcludedFiles.push({
        path: relPath,
        size: stat.size,
        hash,
        reason: sensitiveRule.reason,
      });
      records.push({
        path: relPath,
        kind: detectFileKind(relPath, false),
        size: stat.size,
        hash,
        role: roleFromPath(relPath),
        importance: importanceFromPath(relPath),
        sections: relatedSectionsFromPath(relPath),
        listing: "一覧のみ",
      });
      continue;
    }

    const isText = isProbablyText(relPath, buffer);
    const kind = detectFileKind(relPath, isText);

    if (!isText) {
      binaryRecords.push({
        path: relPath,
        size: stat.size,
        extension: path.extname(relPath) || "(none)",
        hash,
        usage: roleFromPath(relPath),
        handling: "一覧のみ（本文全文は非掲載）",
      });
      records.push({
        path: relPath,
        kind,
        size: stat.size,
        hash,
        role: roleFromPath(relPath),
        importance: importanceFromPath(relPath),
        sections: relatedSectionsFromPath(relPath),
        listing: "一覧のみ",
      });
      continue;
    }

    const decoded = buffer.toString("utf8");
    const encoding = guessEncoding(buffer);
    const redacted = redactSecrets(decoded, relPath);
    totalMaskCount += redacted.masked;

    const listingMode = redacted.masked > 0 ? "マスク掲載" : "全文掲載";

    records.push({
      path: relPath,
      kind,
      size: stat.size,
      hash,
      role: roleFromPath(relPath),
      importance: importanceFromPath(relPath),
      sections: relatedSectionsFromPath(relPath),
      listing: listingMode,
    });

    textAppendixRecords.push({
      path: relPath,
      size: stat.size,
      encoding,
      hash,
      role: roleFromPath(relPath),
      sections: relatedSectionsFromPath(relPath),
      content: redacted.text,
      masked: redacted.masked,
    });
  }

  records.sort((a, b) => a.path.localeCompare(b.path));
  textAppendixRecords.sort((a, b) => a.path.localeCompare(b.path));
  binaryRecords.sort((a, b) => a.path.localeCompare(b.path));
  explicitExcludedFiles.sort((a, b) => a.path.localeCompare(b.path));

  const serverPath = path.join(PROJECT_ROOT, "src/server.mjs");
  const serverCode = fssync.existsSync(serverPath) ? fssync.readFileSync(serverPath, "utf8") : "";
  const apiEndpoints = parseApiEndpoints(serverCode);

  const testFiles = textAppendixRecords
    .filter((record) => record.path.startsWith("tests/") && record.path.endsWith(".test.mjs"))
    .map((record) => record.path);
  const textMap = new Map(textAppendixRecords.map((record) => [record.path, record]));
  const tests = parseTestsWithNames(testFiles, textMap);

  const requiredApis = [
    {
      path: "POST /api/v1/invoices",
      purpose: "請求発行と署名付きpay導線生成",
      auth: "要 (Bearer/session)",
      input: "amount_jpy, Idempotency-Key",
      output: "invoice_id, payment_url, wallet payload",
      transition: "draft/issued作成",
      audit: "対象 (invoice.created)",
      failClosed: "権限不足/Idempotency欠落/kill switch/アドレス枯渇時は拒否",
    },
    {
      path: "GET /api/v1/invoices/:invoiceId",
      purpose: "店舗側請求状態参照",
      auth: "要 (invoice.read)",
      input: "invoiceId",
      output: "invoice詳細, review/refund参照情報",
      transition: "なし",
      audit: "参照系なので通常対象外",
      failClosed: "別店舗スコープ/未認証は拒否",
    },
    {
      path: "POST /api/v1/invoices/:invoiceId/reissue",
      purpose: "期限切れ等の再発行",
      auth: "要 (invoice.create)",
      input: "invoiceId, Idempotency-Key",
      output: "新invoice_idと新pay_url",
      transition: "旧invoiceをexpired/review_requiredへ、新invoiceをissuedへ",
      audit: "対象",
      failClosed: "paid請求からの再発行禁止、receive_address再利用禁止",
    },
    {
      path: "GET /api/v1/public/invoices/:invoiceId",
      purpose: "顧客支払いページ用データ取得",
      auth: "署名クエリ必須 (sig/exp/nonce)",
      input: "invoiceId + query署名",
      output: "支払い状態, wallet_deeplink, payment_uri, copy_fallback",
      transition: "なし",
      audit: "参照系",
      failClosed: "署名不正/期限超過/rate limitは拒否",
    },
    {
      path: "POST /api/v1/payments/events:ingest",
      purpose: "manual ingest (検証付き着金反映)",
      auth: "要 (payment.ingest.manual)",
      input: "invoice_id, tx_hashまたは金額・送金先情報",
      output: "decision/status",
      transition: "confirming/paid/review_required",
      audit: "対象",
      failClosed: "on-chain不一致/confirmations不足はpaid化しない",
    },
    {
      path: "POST /api/v1/internal/payments/events:ingest",
      purpose: "chain monitor からの内部ingest",
      auth: "X-Service-* HMAC署名",
      input: "サービス署名付きpayload",
      output: "decision/status",
      transition: "paymentイベント反映",
      audit: "対象",
      failClosed: "署名不正/replay検知時は409/401で拒否",
    },
    {
      path: "GET/PATCH /api/v1/reviews*",
      purpose: "manual reviewキュー閲覧・更新",
      auth: "要 (review.read/review.update)",
      input: "reviewId, status, note",
      output: "review detail",
      transition: "open/in_progress/resolved/rejected",
      audit: "対象",
      failClosed: "不正遷移/権限不足は拒否",
    },
    {
      path: "POST /api/v1/refunds /:id/approve /:id/execute /:id/verify",
      purpose: "返金申請〜承認〜実行記録〜オンチェーン検証",
      auth: "要 (refund.*)",
      input: "refund情報, tx_hash等",
      output: "refund status",
      transition: "requested→approved→recorded/pending_verification→succeeded/failed",
      audit: "対象",
      failClosed: "二名承認違反・法務ゲート未承認・on-chain不一致時は拒否",
    },
    {
      path: "POST /api/v1/settlements/daily:close / GET /daily:export",
      purpose: "日次締めとCSV/export",
      auth: "要 (settlement.close/export)",
      input: "business_date, unresolved_review制御パラメータ",
      output: "settlement totals / CSV",
      transition: "paid請求をsettlement紐付け",
      audit: "対象",
      failClosed: "未解決reviewポリシー違反時は409",
    },
    {
      path: "GET /api/v1/audit-logs /export /verify-chain",
      purpose: "監査証跡参照・整合検証",
      auth: "要 (audit.read/export)",
      input: "limit,format",
      output: "監査ログ,ハッシュチェーン検証結果",
      transition: "なし",
      audit: "監査系API自体は監査対象外",
      failClosed: "privacy/APPI gate未承認時はexport拒否",
    },
    {
      path: "GET /healthz /readyz /metrics",
      purpose: "稼働監視とGo判定ゲート確認",
      auth: "healthz:不要, readyz/metrics:Bearer METRICS_SECRET",
      input: "なし",
      output: "ok, blockers, metrics",
      transition: "なし",
      audit: "通常対象外",
      failClosed: "監査チェーン不整合/worker stale/商用ゲート未充足でready=503",
    },
    {
      path: "POST /api/v1/admin/payments/* + stores/* + terminals/*",
      purpose: "kill switch（全体/店舗/端末）",
      auth: "要 (payments.control)",
      input: "reason",
      output: "enabled/disabled状態",
      transition: "新規請求受付のみ停止",
      audit: "対象",
      failClosed: "権限不足時は拒否、既存照合は継続",
    },
    {
      path: "POST /api/v1/admin/receive-addresses:import",
      purpose: "受取アドレス在庫投入",
      auth: "要 (address_pool.manage)",
      input: "addresses[]",
      output: "import結果",
      transition: "address pool在庫更新",
      audit: "対象",
      failClosed: "秘密鍵/seed混入らしき入力は拒否",
    },
  ];

  const apiCoverage = requiredApis.map((api) => ({
    ...api,
    existsInCode: apiEndpoints.some((row) => `${row.method} ${row.path}`.includes(api.path.split(" ")[0]) && row.path.includes(api.path.split(" ").pop().replace(/:.*/, ""))),
  }));

  const statusRows = [
    { item: "端末ログイン", status: "実装済み", evidence: "src/server.mjs /api/v1/terminal-sessions" },
    { item: "請求発行", status: "実装済み", evidence: "POST /api/v1/invoices + tests/server-integration.test.mjs" },
    { item: "Dynamic Invoice QR", status: "実装済み", evidence: "public/terminal.js + docs/40-qr-spec.md" },
    { item: "顧客支払いページ", status: "実装済み", evidence: "public/mobile.html, public/mobile.js" },
    { item: "ウォレット起動導線", status: "実装済み（外部実機未検証）", evidence: "src/wallet-adapter.mjs + docs/92-real-device-validation-checklist.md" },
    { item: "chain monitor", status: "実装済み", evidence: "src/chain-monitor.mjs + tests/chain-monitor*.test.mjs" },
    { item: "manual review", status: "実装済み", evidence: "GET/PATCH /api/v1/reviews*" },
    { item: "refund verification", status: "実装済み", evidence: "POST /api/v1/refunds/:id/verify" },
    { item: "audit log hash chain", status: "実装済み", evidence: "audit_logs + scripts/verify-audit-chain.mjs" },
    { item: "daily close", status: "実装済み", evidence: "POST /api/v1/settlements/daily:close" },
    { item: "CSV/export", status: "実装済み", evidence: "GET /api/v1/settlements/daily:export + /api/v1/audit-logs/export" },
    { item: "Docker / systemd / nginx", status: "実装済み", evidence: "Dockerfile, docker-compose.prod.yml, deploy/*" },
    { item: "production validation scripts", status: "実証リリース準備済み", evidence: "scripts/production-validation/*" },
    { item: "実機ウォレット確認", status: "外部検証待ち", evidence: "docs/production/BLOCKED_EXTERNAL_VALIDATION.md EXT-002" },
    { item: "実JPYC少額決済", status: "外部検証待ち", evidence: "BLOCKED_EXTERNAL_VALIDATION EXT-001" },
    { item: "公開TLSホスト確認", status: "外部検証待ち", evidence: "BLOCKED_EXTERNAL_VALIDATION EXT-003" },
    { item: "店舗オペレーション訓練", status: "外部検証待ち", evidence: "BLOCKED_EXTERNAL_VALIDATION EXT-004" },
    { item: "複数店舗スケール/PG移行", status: "Phase 2以降", evidence: "docs/00-current-state.md, docs/31-db-schema.md" },
  ];

  const riskRows = [
    {
      risk: "法務リスク",
      condition: "運用モデルA/B/Cや登録要否が未確定",
      impact: "商用運用の停止・是正コスト増",
      current: "runtime gate(LEGAL/AML/PRIVACY/APPI)とapproval ref必須化",
      remaining: "専門家判断と契約条項の確定",
      priority: "P0",
    },
    {
      risk: "AML/不正利用",
      condition: "高額請求や不審イベント増加",
      impact: "規制対応不備・不正取引見逃し",
      current: "AML threshold, suspicious_activity_logs, review queue",
      remaining: "運用体制・報告手順の実地訓練",
      priority: "P0",
    },
    {
      risk: "誤送金/誤チェーン",
      condition: "顧客が誤トークン・誤チェーンで送金",
      impact: "自動着金不可、顧客対応負荷",
      current: "verifyTransferOnChain fail-closed + review_required",
      remaining: "店頭案内の継続改善",
      priority: "P0",
    },
    {
      risk: "期限後着金",
      condition: "expires_at後に着金",
      impact: "売上認識ミス",
      current: "expired->paid禁止、late paymentをreviewへ",
      remaining: "現場手順の徹底",
      priority: "P0",
    },
    {
      risk: "重複処理",
      condition: "同一tx再送/再取り込み",
      impact: "二重計上",
      current: "payment_attempts unique(chain_id,tx_hash,log_index) + idempotency",
      remaining: "監視閾値の最適化",
      priority: "P0",
    },
    {
      risk: "RPC障害",
      condition: "RPCタイムアウト/断",
      impact: "着金反映遅延",
      current: "複数RPC failover + dead-letter retry",
      remaining: "実環境でのSLA検証",
      priority: "P1",
    },
    {
      risk: "ウォレットUX",
      condition: "deeplink未起動/未インストール",
      impact: "支払い完了率低下",
      current: "wallet_deeplink→payment_uri→wallet_url→copy fallback",
      remaining: "実機証跡の充足",
      priority: "P1",
    },
    {
      risk: "店舗運用ミス",
      condition: "スタッフが例外フローを誤処理",
      impact: "顧客対応遅延/誤返金",
      current: "terminal UIのops summary, runbook, review reasonガイド",
      remaining: "店舗訓練（EXT-004）",
      priority: "P1",
    },
    {
      risk: "返金証跡欠損",
      condition: "manual実行のみでverify未実施",
      impact: "監査不整合",
      current: "recorded/pending_verification/succeededを分離",
      remaining: "verify運用の強制・監査レビュー",
      priority: "P0",
    },
    {
      risk: "秘密情報漏洩",
      condition: "env/ログにsecret混入",
      impact: "不正アクセス",
      current: "production起動時の弱secret拒否 + evidence sanitization",
      remaining: "secret manager連携の本番運用",
      priority: "P0",
    },
    {
      risk: "本番配備",
      condition: "preflight未実行や構成ドリフト",
      impact: "障害復旧遅延",
      current: "deploy:check, preflight, healthcheck, backup/restore drill",
      remaining: "公開FQDN/TLSの最終証跡",
      priority: "P1",
    },
    {
      risk: "SQLite運用限界",
      condition: "多店舗同時負荷増",
      impact: "性能/同時実行制約",
      current: "限定店舗実証にスコープ限定",
      remaining: "PostgreSQL移行設計と段階的移行計画",
      priority: "P2",
    },
    {
      risk: "多店舗展開",
      condition: "導入店舗増加",
      impact: "運用標準化不足",
      current: "運用runbookとevidenceテンプレート整備",
      remaining: "マルチテナント設計・SLA・組織運用",
      priority: "P3",
    },
  ];

  const importantRows = buildImportantFileNotes(new Set(records.map((row) => row.path)));

  const includedTreePaths = records.map((row) => row.path);
  const fileTreeText = buildTree(includedTreePaths, excludedDirStats);

  const inventoryRows = [
    ...records,
    ...[...excludedDirStats.entries()].map(([prefix, stat]) => ({
      path: `${prefix}*`,
      kind: "除外ディレクトリ",
      size: stat.count,
      hash: "-",
      role: "除外対象",
      importance: "低",
      sections: "14,15",
      listing: "一覧のみ",
    })),
  ];

  inventoryRows.sort((a, b) => a.path.localeCompare(b.path));

  const markdown = [];

  markdown.push(`# ${REPORT_TITLE}`);
  markdown.push("");
  markdown.push("## 目次");
  for (let i = 0; i <= 22; i += 1) {
    const titles = {
      0: "表紙",
      1: "エグゼクティブサマリー",
      2: "プロジェクトの目的と事業定義",
      3: "現在のプロダクト状態",
      4: "アーキテクチャ全体像",
      5: "主要フロー",
      6: "状態遷移",
      7: "データモデル / DB設計",
      8: "API仕様",
      9: "QR / モバイル支払いページ / ウォレット導線",
      10: "セキュリティ / 権限 / 秘密情報管理",
      11: "本番配備 / インフラ / 運用",
      12: "法務 / AML / APPI / 承認ゲート",
      13: "テスト / 検証 / Evidence",
      14: "ファイルツリー",
      15: "ファイル別インベントリ",
      16: "重要ファイル別解説",
      17: "未完了・外部検証待ち一覧",
      18: "リスクと対策",
      19: "次にやるべきこと",
      20: "付録A: 全テキストファイル内容",
      21: "付録B: バイナリファイル一覧",
      22: "付録C: 生成ログ",
    };
    markdown.push(`- ${i}. ${titles[i]}`);
  }

  markdown.push("\n---\n");

  markdown.push("## 0. 表紙");
  markdown.push("");
  markdown.push(`- PDFタイトル: **${REPORT_TITLE}**`);
  markdown.push("- 対象プロジェクト名: JPYC決済端末_MVP_UIUX");
  markdown.push(`- 対象ルートパス: ${PROJECT_ROOT}`);
  markdown.push(`- 作成日時: ${dateInfo.timestamp} (${TZ})`);
  markdown.push(`- 生成者: ${GENERATOR}`);
  markdown.push("- 注意書き:");
  markdown.push("  - このPDFはプロジェクトフォルダ内容のみを根拠として生成");
  markdown.push("  - 外部検証が必要な項目は **未検証** と明記");
  markdown.push("  - 法務判断は専門家確認が必要（本書は法的助言ではない）");

  markdown.push("\n## 1. エグゼクティブサマリー");
  markdown.push("");
  markdown.push("**本プロダクトは、JPYCで『払える』こと自体ではなく、払われた後に店舗運用が止まらないための Merchant Ops / Settlement Layer である。**");
  markdown.push("");
  markdown.push("- 何を作っているか:");
  markdown.push("  - 端末UI、公開支払いページ、サーバー、チェーン監視、review queue、返金証跡、日次締め、監査ログを統合した店舗運用OS");
  markdown.push("- なぜ作るか:");
  markdown.push("  - 暗号資産に詳しくないスタッフでも、請求〜着金確認〜過不足対応〜返金証跡〜締め処理まで回せる業務基盤が必要だから");
  markdown.push("- 事業レイヤー:");
  markdown.push("  - 決済手段そのものではなく **Merchant Ops / Settlement Layer**（invoice-first / audit-first）");
  markdown.push("- ノンカストディ境界:");
  markdown.push("  - 顧客資産を預からない、秘密鍵を保持しない、送金署名は顧客ウォレット側");
  markdown.push("- 対象ユーザー:");
  markdown.push("  - 店舗スタッフ、店舗責任者、運用責任者、事業責任者、協力先");
  markdown.push("- 現在の完成度:");
  markdown.push("  - コア実装は概ね整備済み（server/chain monitor/review/refund verify/settlement/audit）");
  markdown.push("  - 本番相当配備資産・検証スクリプトも整備済み");
  markdown.push("- Go/No-Go残課題:");
  markdown.push("  - 実機ウォレット起動、実JPYC少額決済、公開TLSホスト確認、店舗運用訓練は外部検証待ち");
  markdown.push("- 事業上の勝ち筋:");
  markdown.push("  - 小規模店舗/イベントの例外対応と日次運用を、短い改善サイクルで磨けること");
  markdown.push("- 最重要リスク:");
  markdown.push("  - 外部検証未完了のままGO判定する運用リスク、法務承認未確定リスク");

  markdown.push("\n## 2. プロジェクトの目的と事業定義");
  markdown.push("");
  markdown.push("- ゴール:");
  markdown.push("  - JPYC店舗運用を invoice-first ledger で標準化し、支払い後の業務を止めない");
  markdown.push("- 対象顧客:");
  markdown.push("  - 小規模店舗、イベント/ポップアップ運営者、実証導入先");
  markdown.push("- 想定利用シーン:");
  markdown.push("  - 店頭会計、ブース販売、限定イベントでの現金代替支払い");
  markdown.push("- 加盟店向け価値:");
  markdown.push("  - review/refund/settlement/auditまで含めた運用可視化");
  markdown.push("- 企業・イベント運営者向け価値:");
  markdown.push("  - 例外対応と証跡が残るため、運用監査と説明責任を持てる");
  markdown.push("- 単なるQR決済ではない理由:");
  markdown.push("  - QR表示で終わらず、着金照合・例外分岐・返金記録・日次締め・監査ログを一体設計");
  markdown.push("- 核心価値:");
  markdown.push("  - **『払えること』ではなく『払われた後に店舗が困らないこと』**");

  markdown.push("\n## 3. 現在のプロダクト状態");
  markdown.push("");
  markdown.push(renderStatusTable(statusRows));

  markdown.push("\n## 4. アーキテクチャ全体像");
  markdown.push("");
  markdown.push("```mermaid");
  markdown.push("flowchart LR");
  markdown.push('  terminal["Terminal UI\\n(staff)"] --> api["App Server"]');
  markdown.push('  customer["Public Payment Web\\n/mobile.html"] --> api');
  markdown.push('  api --> db["Ledger DB (SQLite)"]');
  markdown.push('  worker["Chain Monitor Worker"] --> api');
  markdown.push('  worker --> rpc["Polygon RPC"]');
  markdown.push('  api --> sse["Realtime Channel (SSE + polling)"]');
  markdown.push('  sse --> terminal');
  markdown.push('  sse --> customer');
  markdown.push('  ops["Ops Layer\\n(runbook/deploy/backup)"] --> api');
  markdown.push('  wallet["Customer Wallet"] --> rpc');
  markdown.push('  note["署名は顧客ウォレット側\\nサーバーは請求・照合・監査・運用制御"]:::note');
  markdown.push('  wallet -.-> note');
  markdown.push('  classDef note fill:#f5f5f5,stroke:#777,stroke-dasharray: 5 5;');
  markdown.push("```");
  markdown.push("");
  markdown.push("- Wallet boundary: 送金署名は顧客ウォレット側のみ");
  markdown.push("- Server boundary: 請求発行・照合・監査・運用制御のみ担当");
  markdown.push("- Operations boundary: kill switch/monitoring/backup/restoreを運用レイヤーで管理");

  markdown.push("\n## 5. 主要フロー");
  markdown.push("");
  markdown.push("### 5.1 店頭請求フロー");
  markdown.push("1. スタッフが `POST /api/v1/terminal-sessions` でログイン");
  markdown.push("2. 金額入力して `POST /api/v1/invoices` でinvoice作成");
  markdown.push("3. 端末に Dynamic Invoice QR（署名付き `/pay?ref=...`）表示");
  markdown.push("4. 顧客が公開支払いページ (`/mobile.html`) を開く");
  markdown.push("5. `wallet_deeplink -> payment_uri -> wallet_url -> copy fallback` でウォレット起動");
  markdown.push("6. 顧客ウォレットで送金署名・送金実行");
  markdown.push("7. chain monitorがTransfer検知、サーバーが照合");
  markdown.push("8. 画面は `paid` / `review_required` / `expired` を表示");
  markdown.push("");
  markdown.push("### 5.2 着金監視フロー");
  markdown.push("1. chain monitorがPolygon RPCをポーリング");
  markdown.push("2. JPYC `Transfer` イベントを検知");
  markdown.push("3. receive_address一致を優先照合");
  markdown.push("4. amount_jpyc_base と expectedを整数比較");
  markdown.push("5. confirmation policyを満たすか確認");
  markdown.push("6. invoice状態を `confirming/paid/review_required` 更新");
  markdown.push("7. SSEで端末/顧客画面へ通知、切断時はpolling fallback");
  markdown.push("8. ingest失敗は dead-letter へ保存し retry");
  markdown.push("");
  markdown.push("### 5.3 例外処理フロー");
  markdown.push("- 不足入金: `UNDERPAYMENT` として review_required");
  markdown.push("- 過入金: `OVERPAYMENT` として review_required");
  markdown.push("- 重複入金: `DUPLICATE_PAYMENT` として review_required");
  markdown.push("- 期限後着金: `LATE_PAYMENT` として review_required（expired->paid禁止）");
  markdown.push("- 誤チェーン: `CHAIN_INCONSISTENT` で fail-closed");
  markdown.push("- 誤トークン: `WRONG_TOKEN` / `UNKNOWN_TRANSFER` で fail-closed");
  markdown.push("- RPC障害: provider failover + state記録");
  markdown.push("- chain monitor ingest失敗: dead-letter upsert");
  markdown.push("- dead-letter retry: exponential backoff、上限超過は abandoned");
  markdown.push("");
  markdown.push("### 5.4 返金証跡フロー");
  markdown.push("1. `refund.request` 申請");
  markdown.push("2. 別担当者が `refund.approve`（two-person rule）");
  markdown.push("3. `refund.execute` は外部実行結果を記録（manual/external_signer/custody_provider）");
  markdown.push("4. `refund.verify` でon-chain Transfer整合を検証");
  markdown.push("5. 一致時のみ `succeeded`、不一致は `verification_failed/failed`");
  markdown.push("6. 監査ログにrequest_id/idempotency_keyと差分を記録");
  markdown.push("- 注記: **システム自身は返金送金に署名しない**");
  markdown.push("");
  markdown.push("### 5.5 日次締めフロー");
  markdown.push("1. `GET /api/v1/settlements/daily-status` で当日状況確認");
  markdown.push("2. unresolved review件数を確認");
  markdown.push("3. `POST /api/v1/settlements/daily:close` で締め");
  markdown.push("4. `GET /api/v1/settlements/daily:export` と監査exportを取得");
  markdown.push("5. audit chain verify結果と一緒に証跡保存");

  markdown.push("\n## 6. 状態遷移");
  markdown.push("");
  markdown.push("### 6.1 Invoice遷移（実装ベース）");
  markdown.push("- `draft -> issued`");
  markdown.push("- `issued -> payment_detected -> confirming -> paid`");
  markdown.push("- `issued -> expired` / `issued -> cancelled`");
  markdown.push("- `payment_detected|confirming|paid|expired -> review_required`（条件付き）");
  markdown.push("");
  markdown.push("### 6.2 Review/Refund遷移");
  markdown.push("- Review: `open -> in_progress -> resolved|rejected`（再オープンは管理運用判断）");
  markdown.push("- Refund: `requested -> approved -> recorded|pending_verification -> succeeded|failed` ");
  markdown.push("");
  markdown.push("### 6.3 不変条件（強調）");
  markdown.push("- `expired -> paid` を禁止");
  markdown.push("- 期限後着金は `review_required` へ送る");
  markdown.push("- `paid` 後の追加入金は `review_required`");
  markdown.push("- `review_required` はスタッフ単独で `paid` へ戻せない（直接遷移APIなし）");
  markdown.push("- 同一 `tx_hash + log_index` は一度だけ処理（payment_attempts unique）");
  markdown.push("");
  markdown.push("```mermaid");
  markdown.push("stateDiagram-v2");
  markdown.push("  [*] --> issued");
  markdown.push("  issued --> payment_detected");
  markdown.push("  payment_detected --> confirming");
  markdown.push("  confirming --> paid");
  markdown.push("  issued --> expired");
  markdown.push("  issued --> cancelled");
  markdown.push("  payment_detected --> review_required");
  markdown.push("  confirming --> review_required");
  markdown.push("  paid --> review_required");
  markdown.push("  expired --> review_required");
  markdown.push("  note right of expired: expired->paidは禁止");
  markdown.push("```");

  markdown.push("\n## 7. データモデル / DB設計");
  markdown.push("");
  markdown.push("### 7.1 主要テーブル（実装）");
  markdown.push("- stores / terminals / staff_users / terminal_sessions");
  markdown.push("- invoices / payment_events / payment_attempts");
  markdown.push("- review_cases / refund_requests");
  markdown.push("- audit_logs / idempotency_records / service_replay_guards");
  markdown.push("- chain_monitor_state / chain_unmatched_events / chain_dead_letters / chain_rpc_failovers");
  markdown.push("- settlements / settlement_exports / settlement_export_runs / settlement_export_rows");
  markdown.push("- receive_addresses / suspicious_activity_logs / rate_limit_events");
  markdown.push("");
  markdown.push("### 7.2 invoice-first ledger");
  markdown.push("- 請求(`invoice`)を正本にし、payment/review/refund/settlementを紐付ける設計");
  markdown.push("- 支払い後運用（例外・返金・締め）を請求単位で追跡できる");
  markdown.push("");
  markdown.push("### 7.3 金額設計");
  markdown.push("- `amount_jpyc_base` 等の整数単位を金融判定の正本に利用");
  markdown.push("- `REAL` / 浮動小数点は表示補助に限定、判定には使わない");
  markdown.push("- `src/amounts.mjs` で scale/parse/compare を統一");
  markdown.push("");
  markdown.push("### 7.4 監査ログhash chain");
  markdown.push("- `audit_logs.prev_hash` と `entry_hash` でチェーン化");
  markdown.push("- `scripts/verify-audit-chain.mjs` と `/api/v1/audit-logs/verify-chain` で整合検証");
  markdown.push("");
  markdown.push("### 7.5 SQLite前提とPostgreSQL移行論点");
  markdown.push("- 現行は限定店舗実証向けにSQLite採用");
  markdown.push("- 多店舗/高負荷フェーズではPostgreSQL移行が論点（型差分・DDL/UPSERT差分・TTL運用差分）");

  markdown.push("\n## 8. API仕様");
  markdown.push("");
  markdown.push("### 8.1 実装ルート一覧（抽出）");
  markdown.push(`- 抽出件数: ${apiEndpoints.length}`);
  markdown.push("- 代表例: " + apiEndpoints.slice(0, 15).map((row) => `${row.method} ${row.path}`).join(" / "));
  markdown.push("");
  markdown.push("### 8.2 主要API詳細");
  markdown.push(renderApiTable(apiCoverage));

  markdown.push("\n## 9. QR / モバイル支払いページ / ウォレット導線");
  markdown.push("");
  markdown.push("- QR payload:");
  markdown.push("  - 署名付き `/pay?ref=...`（invoiceId/exp/nonce/sigを含む）");
  markdown.push("- signed pay URL:");
  markdown.push("  - サーバーがHMACで生成し、公開ページは署名検証を必須化");
  markdown.push("- 公開ページ:");
  markdown.push("  - `/mobile.html` + `/api/v1/public/invoices/:id?sig=...` で表示");
  markdown.push("- EIP-681 URI:");
  markdown.push("  - `ethereum:<token>@137/transfer?address=<to>&uint256=<amount_atomic>`");
  markdown.push("- wallet導線:");
  markdown.push("  - `wallet_deeplink` -> `payment_uri` -> `wallet_url` -> copy fallback");
  markdown.push("- 対応ウォレット表示:");
  markdown.push("  - HashPort Wallet / WalletConnect / Injected Wallet（設定依存）");
  markdown.push("- 未インストール時:");
  markdown.push("  - wallet_help_url案内 + 手動送金fallback");
  markdown.push("- copy fallback:");
  markdown.push("  - address/network/token/amount_atomicを明示してコピー可能");
  markdown.push("- セキュリティ原則:");
  markdown.push("  - 顧客に秘密鍵/seed phraseの入力をさせない");

  markdown.push("\n## 10. セキュリティ / 権限 / 秘密情報管理");
  markdown.push("");
  markdown.push("- 権限モデル:");
  markdown.push("  - staff/operator: invoice中心");
  markdown.push("  - manager: review/refund approve/settlement/audit read");
  markdown.push("  - admin: staff/terminal管理, manual ingest, refund execute, monitor, kill switch");
  markdown.push("- session TTL:");
  markdown.push("  - `SESSION_TTL_SEC`、失効後は401");
  markdown.push("- PIN lockout:");
  markdown.push("  - `PIN_LOCKOUT_MAX_ATTEMPTS` と `PIN_LOCKOUT_SEC` をDB永続化");
  markdown.push("- two-person rule:");
  markdown.push("  - refund requested_by != approved_by、（有効時）approved_by != executed_by");
  markdown.push("- APP_SECRET / SERVICE_INGEST_SECRET / METRICS_SECRET:");
  markdown.push("  - 本番で弱い値を拒否して起動失敗（fail-closed）");
  markdown.push("- .env掲載方針:");
  markdown.push("  - 本レポートでは秘密値をマスク掲載");
  markdown.push("- private key / seed phrase / mnemonic / keystore:");
  markdown.push("  - 生成・保存・預かりを行わない設計");
  markdown.push("- CORS:");
  markdown.push("  - allowlist方式、ワイルドカード禁止");
  markdown.push("- rate limit:");
  markdown.push("  - login/public APIにハイブリッドレート制限");
  markdown.push("- SSE token:");
  markdown.push("  - invoice/terminal/sessionに紐づく短命署名トークン");
  markdown.push("- replay guard:");
  markdown.push("  - X-Service-JTIをDBに記録して再送拒否");
  markdown.push("- idempotency:");
  markdown.push("  - `actor + endpoint + Idempotency-Key` で重複排除");

  markdown.push("\n## 11. 本番配備 / インフラ / 運用");
  markdown.push("");
  markdown.push("- 配備資産:");
  markdown.push("  - Dockerfile / docker-compose.prod.yml / systemd / nginx config");
  markdown.push("- healthcheck:");
  markdown.push("  - `/healthz`（liveness） / `/readyz`（gates） / `/metrics`（Prometheus/JSON）");
  markdown.push("- backup / restore:");
  markdown.push("  - `scripts/deploy/backup-sqlite.sh`, `restore-drill.sh`（quick_check + audit verify）");
  markdown.push("- deployment scripts:");
  markdown.push("  - `preflight.sh`, `healthcheck.sh`, `collect-logs.sh`, `check.sh`");
  markdown.push("- production validation:");
  markdown.push("  - `scripts/production-validation/run-all.sh` でevidence一式生成");
  markdown.push("- evidence directory:");
  markdown.push("  - `docs/production/evidence/<timestamp>/...`");
  markdown.push("- restore drill:");
  markdown.push("  - 本番DBを直接上書きせず一時復元で検証");
  markdown.push("- smoke test / audit chain:");
  markdown.push("  - `scripts/smoke-test.mjs`, `scripts/verify-audit-chain.mjs`");
  markdown.push("- CI:");
  markdown.push("  - `.github/workflows/ci.yml` で check/test/audit/smoke/deploy/production validation を実行");

  markdown.push("\n## 12. 法務 / AML / APPI / 承認ゲート");
  markdown.push("");
  markdown.push("### 12.1 プロジェクト文書上の確認項目");
  markdown.push("- legal gate: `LEGAL_GATE_APPROVED` + `LEGAL_GATE_APPROVAL_REF`");
  markdown.push("- AML policy: `AML_POLICY_APPROVED` + `AML_POLICY_APPROVAL_REF`");
  markdown.push("- privacy policy: `PRIVACY_POLICY_APPROVED` + `PRIVACY_POLICY_APPROVAL_REF`");
  markdown.push("- APPI: `APPI_POLICY_APPROVED` + `APPI_POLICY_APPROVAL_REF` + retention/deletion/disclosure refs");
  markdown.push("- approval refはproduction起動前提として必須化");
  markdown.push("- Model A/B/C論点、加盟店契約、返金責任分界、保存年限の質問票が docs/10,11 に定義済み");
  markdown.push("");
  markdown.push("### 12.2 専門家判断が必要な項目（法的断定はしない）");
  markdown.push("- 電子決済手段等取引業・電子決済等取扱業の該当性");
  markdown.push("- AML/CFTの実運用体制・報告基準");
  markdown.push("- 加盟店契約条項と返金責任分界の確定");
  markdown.push("- 監査ログ保存年限とAPPI削除/開示手順の法務整合");
  markdown.push("- これらは `外部承認が必要` として管理されるべき項目");

  markdown.push("\n## 13. テスト / 検証 / Evidence");
  markdown.push("");
  markdown.push("### 13.1 実行コマンド群");
  markdown.push("- `npm run check`");
  markdown.push("- `npm test`");
  markdown.push("- `npm run audit`");
  markdown.push("- `npm run test:smoke`");
  markdown.push("- `npm run test:audit-chain`");
  markdown.push("- `npm run deploy:check`");
  markdown.push("- `npm run production:validate`");
  markdown.push("- `npm run production:validate:env`");
  markdown.push("\n### 13.2 テストファイル一覧と保証内容");
  markdown.push(renderTestTable(tests));
  markdown.push("");
  markdown.push("### 13.3 external validation pending");
  markdown.push("- 実機ウォレット検証（EXT-002）");
  markdown.push("- 実JPYC少額決済（EXT-001）");
  markdown.push("- public FQDN/TLS確認（EXT-003）");
  markdown.push("- store ops drill（EXT-004）");

  markdown.push("\n## 14. ファイルツリー");
  markdown.push("");
  markdown.push("```text");
  markdown.push(fileTreeText);
  markdown.push("```");
  markdown.push("");
  markdown.push("### 14.1 除外ファイル一覧（理由付き）");
  if (explicitExcludedFiles.length === 0) {
    markdown.push("- 該当なし");
  } else {
    explicitExcludedFiles.forEach((row) => {
      markdown.push(`- ${row.path} (${bytesHuman(row.size)}) : ${row.reason}`);
    });
  }

  markdown.push("\n## 15. ファイル別インベントリ");
  markdown.push("");
  markdown.push(renderInventoryTable(inventoryRows));

  markdown.push("\n## 16. 重要ファイル別解説");
  markdown.push("");
  markdown.push(renderImportantFileTable(importantRows));

  markdown.push("\n## 17. 未完了・外部検証待ち一覧");
  markdown.push("");
  markdown.push("### 17.1 実装済みだが外部証跡待ち");
  markdown.push("- HashPort Wallet実機起動確認（EXT-002）");
  markdown.push("- 実JPYC少額決済（EXT-001）");
  markdown.push("- 公開TLSホスト確認（EXT-003）");
  markdown.push("- 店舗スタッフ運用訓練（EXT-004）");
  markdown.push("");
  markdown.push("### 17.2 実装として未完了 / Phase2以降");
  markdown.push("- 多店舗・高負荷向けのDB/配備再設計（PostgreSQL移行含む）");
  markdown.push("- 広域営業展開向け運用SLA標準化");
  markdown.push("- 多チェーン展開（現行はPolygon+JPYC前提）");
  markdown.push("");
  markdown.push("### 17.3 法務・承認待ち");
  markdown.push("- legal / AML / privacy / APPI の最終承認記録確定");
  markdown.push("- approval refの署名付き議事録紐付け");
  markdown.push("- 加盟店契約と返金責任分界の専門家確定");

  markdown.push("\n## 18. リスクと対策");
  markdown.push("");
  markdown.push(renderRiskTable(riskRows));

  markdown.push("\n## 19. 次にやるべきこと");
  markdown.push("");
  markdown.push("### P0: 限定店舗実証前に必須");
  markdown.push("- 技術: EXT-001/002/003を実施し証跡を収集");
  markdown.push("- 法務: legal/AML/APPI approval refを本番設定と照合");
  markdown.push("- 運用: EXT-004訓練（締め・障害対応・kill switch）");
  markdown.push("- 営業/導入: 対象店舗・端末・責任者をminutesに固定");
  markdown.push("");
  markdown.push("### P1: 限定店舗実証中に改善");
  markdown.push("- 技術: dead-letter/worker staleの監視閾値を調整");
  markdown.push("- 法務: Q&Aログ（docs/11）の回答充足");
  markdown.push("- 運用: review reason別の対応SOP最適化");
  markdown.push("- 営業/導入: PoC KPIテンプレート（POC-001~003）運用");
  markdown.push("");
  markdown.push("### P2: 実証後に拡張");
  markdown.push("- 技術: PostgreSQL移行PoC・マイグレーション方針");
  markdown.push("- 法務: 契約テンプレートと保存年限の確定版化");
  markdown.push("- 運用: マルチ店舗共通運用指標設計");
  markdown.push("- 営業/導入: 業種別導入テンプレート整備");
  markdown.push("");
  markdown.push("### P3: 事業展開・複数店舗展開");
  markdown.push("- 技術: マルチテナント監視・可用性強化・冗長化");
  markdown.push("- 法務: 事業モデル拡張時の規制再判定");
  markdown.push("- 運用: 監査証跡の長期保管と検索運用");
  markdown.push("- 営業/導入: 導入支援・教育パッケージ化");

  markdown.push("\n## 20. 付録A: 全テキストファイル内容");
  markdown.push("");
  markdown.push(`- 掲載件数: ${textAppendixRecords.length}`);
  markdown.push("- 秘密情報は自動マスク済み");
  markdown.push("");

  for (const record of textAppendixRecords) {
    markdown.push("---");
    markdown.push(`File: ${record.path}`);
    markdown.push(`Bytes: ${record.size}`);
    markdown.push(`Encoding: ${record.encoding}`);
    markdown.push(`SHA256: ${record.hash}`);
    markdown.push(`Role: ${record.role}`);
    markdown.push(`Related Sections: ${record.sections}`);
    markdown.push(`MaskCount: ${record.masked}`);
    markdown.push("Content:");
    markdown.push("````text");
    markdown.push(record.content);
    markdown.push("````");
    markdown.push("");
  }

  markdown.push("\n## 21. 付録B: バイナリファイル一覧");
  markdown.push("");
  markdown.push(`- 一覧件数: ${binaryRecords.length}`);
  markdown.push("");
  markdown.push("| path | size | extension | SHA256 | 推定用途 | PDF化時の扱い |");
  markdown.push("|---|---:|---|---|---|---|");
  for (const row of binaryRecords) {
    markdown.push(
      `| ${markdownEscapeCell(row.path)} | ${markdownEscapeCell(bytesHuman(row.size))} | ${markdownEscapeCell(row.extension)} | ${markdownEscapeCell(row.hash)} | ${markdownEscapeCell(row.usage)} | ${markdownEscapeCell(row.handling)} |`
    );
  }

  markdown.push("\n## 22. 付録C: 生成ログ");
  markdown.push("");
  markdown.push(`- 生成日時: ${dateInfo.timestamp} (${TZ})`);
  markdown.push(`- 対象ルート: ${PROJECT_ROOT}`);
  markdown.push(`- 走査ファイル数: ${allFiles.length}`);
  markdown.push(`- 本文掲載対象テキストファイル数: ${textAppendixRecords.length}`);
  markdown.push(`- 一覧化したバイナリファイル数: ${binaryRecords.length}`);
  markdown.push(`- 除外ファイル数: ${[...excludedDirStats.values()].reduce((sum, v) => sum + v.count, 0) + explicitExcludedFiles.length}`);
  markdown.push(`- マスク件数: ${totalMaskCount}`);
  markdown.push(`- 生成スクリプト: scripts/export-project-understanding-report.mjs`);
  markdown.push(`- 使用ライブラリ: Node.js標準ライブラリ, Python reportlab`);
  markdown.push(`- 読み取り不能ファイル数: ${unreadableFiles.length}`);
  if (unreadableFiles.length > 0) {
    markdown.push("");
    markdown.push("### 読み取り不能ファイル");
    unreadableFiles.forEach((row) => {
      markdown.push(`- ${row.path}: ${row.error}`);
    });
  }

  await fs.writeFile(markdownPath, markdown.join("\n"), "utf8");

  const pyPath = path.join(deliverablesDir, `.render_pdf_${dateInfo.ymdCompact}.py`);
  buildPythonRendererScript(pyPath);

  const render = spawnSync("python3", [pyPath, markdownPath, pdfPath], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  let renderInfo = null;
  if (render.status === 0) {
    try {
      renderInfo = JSON.parse(String(render.stdout || "{}"));
    } catch {
      renderInfo = null;
    }
  }

  const pageCount = renderInfo?.pages || 0;
  const pdfSize = renderInfo?.pdf_size || (fssync.existsSync(pdfPath) ? fssync.statSync(pdfPath).size : 0);

  const generationLog = [];
  generationLog.push(`generated_at=${dateInfo.timestamp} (${TZ})`);
  generationLog.push(`project_root=${PROJECT_ROOT}`);
  generationLog.push(`markdown_path=${markdownPath}`);
  generationLog.push(`pdf_path=${pdfPath}`);
  generationLog.push(`scanned_files=${allFiles.length}`);
  generationLog.push(`candidate_files=${candidateFiles.length}`);
  generationLog.push(`text_files_included=${textAppendixRecords.length}`);
  generationLog.push(`binary_files_listed=${binaryRecords.length}`);
  generationLog.push(`excluded_files=${[...excludedDirStats.values()].reduce((sum, v) => sum + v.count, 0) + explicitExcludedFiles.length}`);
  generationLog.push(`masked_entries=${totalMaskCount}`);
  generationLog.push(`unreadable_files=${unreadableFiles.length}`);
  generationLog.push(`pdf_pages=${pageCount}`);
  generationLog.push(`pdf_size_bytes=${pdfSize}`);
  generationLog.push(`pdf_size_human=${bytesHuman(pdfSize)}`);
  generationLog.push(`renderer_exit_code=${render.status}`);
  if (render.stderr) {
    generationLog.push("renderer_stderr_start");
    generationLog.push(String(render.stderr).trim());
    generationLog.push("renderer_stderr_end");
  }
  if (render.stdout) {
    generationLog.push("renderer_stdout_start");
    generationLog.push(String(render.stdout).trim());
    generationLog.push("renderer_stdout_end");
  }

  if (unreadableFiles.length > 0) {
    generationLog.push("unreadable_file_list_start");
    unreadableFiles.forEach((row) => generationLog.push(`${row.path}\t${row.error}`));
    generationLog.push("unreadable_file_list_end");
  }

  await fs.writeFile(generationLogPath, generationLog.join("\n") + "\n", "utf8");

  try {
    await fs.unlink(pyPath);
  } catch {
    // no-op
  }

  const summary = {
    ok: render.status === 0 && fssync.existsSync(pdfPath),
    markdown_path: markdownPath,
    pdf_path: pdfPath,
    generation_log_path: generationLogPath,
    pages: pageCount,
    pdf_size_bytes: pdfSize,
    scanned_files: allFiles.length,
    candidate_files: candidateFiles.length,
    text_files_included: textAppendixRecords.length,
    binary_files_listed: binaryRecords.length,
    excluded_files: [...excludedDirStats.values()].reduce((sum, v) => sum + v.count, 0) + explicitExcludedFiles.length,
    masked_entries: totalMaskCount,
    unreadable_files: unreadableFiles.length,
  };

  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");

  if (!summary.ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(String(error.stack || error.message || error));
  process.exit(1);
});
