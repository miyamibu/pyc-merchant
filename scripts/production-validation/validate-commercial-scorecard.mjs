#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function yesNo(value) {
  return value ? "PASS" : "FAIL";
}

function toSafeArray(value) {
  return Array.isArray(value) ? value : [];
}

function renderGateRows(report) {
  const gates = report.gates || {};
  return [
    ["production env", gates.production_env_gate],
    ["commercial mode", gates.commercial_go_mode_gate],
    ["legal gate", gates.legal_gate],
    ["aml gate", gates.aml_gate],
    ["privacy gate", gates.privacy_gate],
    ["appi gate", gates.appi_gate],
    ["jpyc contract gate", gates.jpyc_contract_gate],
    ["confirmation policy gate", gates.confirmation_policy_gate],
    ["backscan policy gate", gates.backscan_policy_gate],
    ["dangerous flags gate", gates.dangerous_flags_gate],
    ["audit chain gate", gates.audit_chain_gate],
    ["refund policy gate", gates.refund_policy_gate],
    ["settlement policy gate", gates.settlement_policy_gate],
    ["wallet evidence gate", gates.wallet_evidence_gate],
    ["real payment evidence gate", gates.real_payment_evidence_gate],
    ["tls evidence gate", gates.tls_evidence_gate],
    ["store ops drill gate", gates.store_ops_drill_gate],
    ["poc package gate", gates.poc_package_gate],
  ];
}

export function renderCommercialScorecard(report) {
  const blockers = report.blockers || {};
  const p0 = toSafeArray(blockers.P0);
  const p1 = toSafeArray(blockers.P1);
  const p2 = toSafeArray(blockers.P2);
  const lines = [];
  lines.push("# Commercial Go Scorecard");
  lines.push("");
  lines.push(`- Generated at: ${report.generated_at || "-"}`);
  lines.push(`- App env: ${report.app_env || "-"}`);
  lines.push(`- Evidence root: ${report.evidence_root || "-"}`);
  lines.push(`- Latest evidence dir: ${report.latest_evidence_dir || "-"}`);
  lines.push(`- Verdict: ${report.verdict || "-"}`);
  lines.push(`- Commercial score: ${Number(report.score || 0).toFixed(1)} / 10`);
  lines.push("");
  lines.push("## Gate Summary");
  lines.push("");
  lines.push("| Gate | Status |");
  lines.push("|---|---|");
  for (const [name, value] of renderGateRows(report)) {
    lines.push(`| ${name} | ${yesNo(Boolean(value))} |`);
  }
  lines.push("");
  lines.push("## Blockers");
  lines.push("");
  lines.push(`- P0 blockers (${p0.length})`);
  if (p0.length === 0) lines.push("- none");
  for (const blocker of p0) lines.push(`- ${blocker}`);
  lines.push("");
  lines.push(`- P1 blockers (${p1.length})`);
  if (p1.length === 0) lines.push("- none");
  for (const blocker of p1) lines.push(`- ${blocker}`);
  lines.push("");
  lines.push(`- P2 blockers (${p2.length})`);
  if (p2.length === 0) lines.push("- none");
  for (const blocker of p2) lines.push(`- ${blocker}`);
  lines.push("");
  lines.push("## Evidence Status");
  lines.push("");
  const ext = report.external_evidence || {};
  for (const key of ["EXT_001", "EXT_002", "EXT_003", "EXT_004"]) {
    const row = ext[key] || {};
    lines.push(`- ${key}: ${row.status || "missing"} (${row.file || "file missing"})`);
    if (Array.isArray(row.errors) && row.errors.length > 0) {
      lines.push(`- ${key} errors: ${row.errors.join(", ")}`);
    }
  }
  lines.push("");
  const poc = toSafeArray(report.poc_evidence);
  lines.push("## PoC KPI Status");
  lines.push("");
  if (poc.length === 0) {
    lines.push("- POC-001..003 evidence not found");
  } else {
    for (const row of poc) {
      lines.push(`- ${row.id}: ${row.status || "missing"} (${row.file || "file missing"})`);
      if (Array.isArray(row.errors) && row.errors.length > 0) {
        lines.push(`- ${row.id} errors: ${row.errors.join(", ")}`);
      }
    }
  }
  lines.push("");
  lines.push("## Go / No-Go");
  lines.push("");
  lines.push(`- Verdict: ${report.verdict || "NO_GO"}`);
  lines.push(`- Commercial 9.0 ready: ${yesNo(report.commercial_9_ready === true)}`);
  lines.push(`- Commercial 10.0 ready: ${yesNo(report.commercial_10_ready === true)}`);
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("- 外部証跡や法務承認に pending/fail/missing がある場合は Commercial Go 判定を出さない。");
  lines.push("- このスコアカードは fail-closed 運用を前提に生成される。");
  return `${lines.join("\n")}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(process.cwd(), args.get("input") || "docs/production/evidence/latest/commercial-go-validation.json");
  const defaultOutputPath = path.join(path.dirname(inputPath), "commercial-go-scorecard.md");
  const outputPath = path.resolve(process.cwd(), args.get("output") || defaultOutputPath);
  const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const markdown = renderCommercialScorecard(payload);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, markdown, "utf8");
  console.log(
    JSON.stringify(
      {
        ok: true,
        input: inputPath,
        output: outputPath,
        generated_at: new Date().toISOString(),
      },
      null,
      2
    )
  );
}

const THIS_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(THIS_FILE)) {
  main();
}
