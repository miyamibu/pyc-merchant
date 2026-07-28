import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function walkMarkdown(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkMarkdown(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("docs and env examples do not retain unfinished markers", () => {
  const blockedTerms = [
    ["TO", "DO"].join(""),
    ["FIX", "ME"].join(""),
    ["TB", "D"].join(""),
    ["法務", "確認待ち"].join(""),
    ["change", "me"].join(""),
    ["unsafe", "-inline"].join(""),
    ["default", " secret"].join(""),
  ];
  const keywordPattern = new RegExp(
    [
      `\\b(?:${blockedTerms.slice(0, 3).map(escapeRegExp).join("|")})\\b`,
      ...blockedTerms.slice(3).map((term) => escapeRegExp(term)),
    ].join("|")
  );
  const files = [
    path.join(ROOT, "README.md"),
    path.join(ROOT, ".env.example"),
    path.join(ROOT, ".env.production.example"),
    ...walkMarkdown(path.join(ROOT, "docs")),
  ];

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, "utf8");
    assert.doesNotMatch(content, keywordPattern, `forbidden marker found in ${path.relative(ROOT, filePath)}`);
  }
});

test("production env example declares the required approval and verification gates", () => {
  const content = fs.readFileSync(path.join(ROOT, ".env.production.example"), "utf8");
  for (const key of [
    "PAY_BASE_URL",
    "PUBLIC_BASE_URL",
    "APPROVED_JPYC_TOKEN_CONTRACT",
    "JPYC_CONTRACT_APPROVAL_REF",
    "COMMERCIAL_GO_MODE",
    "LEGAL_GATE_APPROVED",
    "LEGAL_GATE_APPROVAL_REF",
    "AML_POLICY_APPROVED",
    "AML_POLICY_APPROVAL_REF",
    "PRIVACY_POLICY_APPROVED",
    "PRIVACY_POLICY_APPROVAL_REF",
    "APPI_POLICY_APPROVED",
    "APPI_POLICY_APPROVAL_REF",
    "APPI_RETENTION_POLICY_REF",
    "APPI_DELETION_PROCEDURE_REF",
    "APPI_DISCLOSURE_PROCEDURE_REF",
    "MIN_REQUIRED_CONFIRMATIONS",
    "CONFIRMATIONS_POLICY_APPROVAL_REF",
    "MONITOR_BACKSCAN_BLOCKS",
    "BACKSCAN_POLICY_APPROVAL_REF",
    "DIAGNOSTIC_MODE_APPROVAL_REF",
    "MANUAL_INGEST_APPROVAL_REF",
    "SETTLEMENT_UNRESOLVED_REVIEW_POLICY",
    "RPC_URLS",
    "APPROVED_TOKEN_NAME",
    "APPROVED_TOKEN_CODE_HASH",
    "APPROVED_TOKEN_IMPLEMENTATION_CODE_HASH",
    "WALLET_ADAPTER_REGISTRY_JSON",
    "SSE_TOKEN_MAX_TTL_SEC",
  ]) {
    assert.match(content, new RegExp(`^${key}=`, "m"), `${key} is missing from .env.production.example`);
  }
});

test("env examples separate 18-decimal token atomic units from the 1e6 accounting ledger scale", () => {
  for (const fileName of [".env.example", ".env.production.example"]) {
    const content = fs.readFileSync(path.join(ROOT, fileName), "utf8");
    const decimals = content.match(/^TOKEN_DECIMALS=(\d+)$/m)?.[1];
    const ledgerDecimals = content.match(/^LEDGER_DECIMALS=(\d+)$/m)?.[1];
    const scale = content.match(/^LEDGER_BASE_UNIT_SCALE=(\d+)$/m)?.[1];
    assert.equal(decimals, "18", `${fileName} TOKEN_DECIMALS must match the on-chain JPYC atomic unit`);
    assert.equal(ledgerDecimals, "6", `${fileName} LEDGER_DECIMALS must match the accounting unit`);
    assert.equal(scale, "1000000", `${fileName} LEDGER_BASE_UNIT_SCALE must stay at 1_000_000`);
  }
});
