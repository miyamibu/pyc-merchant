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

function boolFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function parseStatus(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "missing";
  if (["pass", "ok", "approved", "signed"].includes(value)) return "pass";
  if (["pending", "todo", "tbd", "in_progress"].includes(value)) return "pending";
  if (["fail", "failed", "rejected", "no"].includes(value)) return "fail";
  return value;
}

function parseMarkdown(content) {
  const text = String(content || "");
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^[\-\*]?\s*([A-Za-z0-9_\-\s\.\(\)\/]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = String(m[1]).trim().toLowerCase().replace(/[\s\.\-\/\(\)]+/g, "_");
    fields[key] = String(m[2] || "").trim();
  }
  const status = parseStatus(fields.status || fields.判定 || fields.status_pass_fail_pending || "");
  return { fields, status, raw: text };
}

function looksLikePlaceholder(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return true;
  if (["pending", "tbd", "todo", "n/a", "na", "none", "sample", "example", "placeholder", "replace-me"].includes(v)) return true;
  return v.includes("example") || v.includes("placeholder") || v.includes("replace");
}

function isTxHash(value) {
  return /^0x[0-9a-f]{64}$/i.test(String(value || "").trim());
}

function normalizeEvidenceDomain(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/\.+$/, "");
  if (!raw) return "";
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return parsed.hostname.toLowerCase().replace(/\.+$/, "");
  } catch (_error) {
    return raw.split("/")[0].replace(/\.+$/, "");
  }
}

function parseEvidenceDate(value) {
  const timestamp = Date.parse(String(value || "").trim());
  return Number.isFinite(timestamp) ? timestamp : null;
}

function findLatestEvidenceDir(rootDir) {
  if (!fs.existsSync(rootDir)) return null;
  const dirs = fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: path.join(rootDir, entry.name) }))
    .sort((a, b) => b.name.localeCompare(a.name));
  const timestampDirs = dirs.filter((dir) => /^\d{8}T\d{6}Z$/.test(dir.name));
  const candidates = timestampDirs.length > 0 ? timestampDirs : dirs.filter((dir) => String(dir.name || "").toLowerCase() !== "templates");
  for (const dir of candidates) {
    const hasAny = [
      "EXT-001-real-jpyc-payment.md",
      "EXT-002-wallet-device-launch.md",
      "EXT-002-hashport-device-launch.md",
      "EXT-003-public-fqdn-tls.md",
      "EXT-004-store-ops-drill.md",
    ].some((file) => fs.existsSync(path.join(dir.path, file)));
    if (hasAny) return dir.path;
  }
  return candidates[0]?.path || null;
}

function readEvidence(dirPath, candidates) {
  for (const fileName of candidates) {
    const fullPath = path.join(dirPath, fileName);
    if (!fs.existsSync(fullPath)) continue;
    const parsed = parseMarkdown(fs.readFileSync(fullPath, "utf8"));
    return { file: fullPath, ...parsed };
  }
  return { file: null, fields: {}, status: "missing", raw: "" };
}

function ensureField(errors, fields, key, label = key) {
  const value = fields[key];
  if (looksLikePlaceholder(value)) {
    errors.push(`missing_${label}`);
    return null;
  }
  return value;
}

function evaluateExt001(evidence) {
  const errors = [];
  if (!evidence.file) errors.push("missing_file");
  if (evidence.status !== "pass") errors.push(`status_${evidence.status}`);
  const txHash = ensureField(errors, evidence.fields, "actual_tx_hash", "actual_tx_hash")
    || ensureField(errors, evidence.fields, "tx_hash", "tx_hash");
  if (txHash && !isTxHash(txHash)) errors.push("invalid_tx_hash");
  ensureField(errors, evidence.fields, "invoice_id", "invoice_id");
  ensureField(errors, evidence.fields, "amount", "amount");
  ensureField(errors, evidence.fields, "expected_amount_atomic", "expected_amount_atomic");
  ensureField(errors, evidence.fields, "block_number", "block_number");
  ensureField(errors, evidence.fields, "block_timestamp", "block_timestamp");
  ensureField(errors, evidence.fields, "detected_at", "detected_at");
  ensureField(errors, evidence.fields, "status_transition", "status_transition");
  ensureField(errors, evidence.fields, "tester", "tester");
  return { ok: errors.length === 0, errors };
}

function evaluateExt002(evidence) {
  const errors = [];
  if (!evidence.file) errors.push("missing_file");
  if (evidence.status !== "pass") errors.push(`status_${evidence.status}`);
  const ios = parseStatus(evidence.fields.hashport_wallet_ios_status || evidence.fields.hashport_ios_status || "");
  const android = parseStatus(evidence.fields.hashport_wallet_android_status || evidence.fields.hashport_android_status || "");
  const copy = parseStatus(evidence.fields.copy_fallback_status || "");
  if (ios && ios !== "pass") errors.push(`ios_${ios}`);
  if (android && android !== "pass") errors.push(`android_${android}`);
  if (copy && copy !== "pass") errors.push(`copy_fallback_${copy}`);
  ensureField(errors, evidence.fields, "screenshot_ref", "screenshot_ref");
  ensureField(errors, evidence.fields, "tester", "tester");
  ensureField(errors, evidence.fields, "checked_at", "checked_at");
  return { ok: errors.length === 0, errors };
}

function evaluateExt003(evidence) {
  const errors = [];
  if (!evidence.file) errors.push("missing_file");
  if (evidence.status !== "pass") errors.push(`status_${evidence.status}`);
  const domain = ensureField(errors, evidence.fields, "domain", "domain");
  const normalizedDomain = normalizeEvidenceDomain(domain);
  if (domain && (/example\.com/i.test(domain) || /placeholder/i.test(domain))) errors.push("placeholder_domain");
  ensureField(errors, evidence.fields, "tls_issuer", "tls_issuer");
  const tlsExpiry = ensureField(errors, evidence.fields, "tls_expiry", "tls_expiry");
  if (tlsExpiry) {
    const expiryTimestamp = parseEvidenceDate(tlsExpiry);
    if (expiryTimestamp == null) errors.push("invalid_tls_expiry");
    else if (expiryTimestamp <= Date.now()) errors.push("expired_tls_certificate");
  }
  const tlsSan = ensureField(errors, evidence.fields, "tls_san", "tls_san");
  if (tlsSan && normalizedDomain) {
    const sanDomains = String(tlsSan)
      .split(/[\s,;]+/)
      .map(normalizeEvidenceDomain)
      .filter(Boolean);
    if (!sanDomains.includes(normalizedDomain) && !sanDomains.includes(`*.${normalizedDomain.split(".").slice(1).join(".")}`)) {
      errors.push("tls_san_mismatch");
    }
  }
  for (const [key, label] of [
    ["healthz_result", "healthz"],
    ["readyz_result", "readyz"],
    ["pay_ref_result", "pay_ref"],
    ["https_redirect_result", "https_redirect"],
  ]) {
    const result = ensureField(errors, evidence.fields, key, key);
    if (result && parseStatus(result) !== "pass") errors.push(`${label}_${parseStatus(result)}`);
  }
  ensureField(errors, evidence.fields, "screenshot_ref", "screenshot_ref");
  ensureField(errors, evidence.fields, "tester", "tester");
  ensureField(errors, evidence.fields, "checked_at", "checked_at");
  return { ok: errors.length === 0, errors };
}

function evaluateExt004(evidence) {
  const errors = [];
  if (!evidence.file) errors.push("missing_file");
  if (evidence.status !== "pass") errors.push(`status_${evidence.status}`);
  ensureField(errors, evidence.fields, "participant", "participant");
  ensureField(errors, evidence.fields, "scenario", "scenario");
  ensureField(errors, evidence.fields, "invoice_issue_time", "invoice_issue_time");
  ensureField(errors, evidence.fields, "qr_display_time", "qr_display_time");
  ensureField(errors, evidence.fields, "review_handling", "review_handling");
  ensureField(errors, evidence.fields, "refund_evidence_handling", "refund_evidence_handling");
  ensureField(errors, evidence.fields, "daily_close", "daily_close");
  ensureField(errors, evidence.fields, "incident_escalation", "incident_escalation");
  ensureField(errors, evidence.fields, "self_resolution_result", "self_resolution_result");
  ensureField(errors, evidence.fields, "operator_signature", "operator_signature");
  return { ok: errors.length === 0, errors };
}

function evaluatePocEvidence(dirPath) {
  const pocIds = ["POC-001", "POC-002", "POC-003"];
  const results = [];
  for (const pocId of pocIds) {
    const filePath = path.join(dirPath, `${pocId}.md`);
    if (!fs.existsSync(filePath)) {
      results.push({ id: pocId, file: filePath, status: "missing", ok: false, errors: ["missing_file"] });
      continue;
    }
    const parsed = parseMarkdown(fs.readFileSync(filePath, "utf8"));
    const errors = [];
    if (parsed.status !== "pass") errors.push(`status_${parsed.status}`);
    ensureField(errors, parsed.fields, "kpi_result", "kpi_result");
    ensureField(errors, parsed.fields, "daily_close_reproduced", "daily_close_reproduced");
    ensureField(errors, parsed.fields, "csv_reconciliation", "csv_reconciliation");
    ensureField(errors, parsed.fields, "signed_minutes_ref", "signed_minutes_ref");
    results.push({ id: pocId, file: filePath, status: parsed.status, ok: errors.length === 0, errors });
  }
  return results;
}
export function validateCommercialEvidence({
  evidenceRoot = path.resolve(process.cwd(), "docs/production/evidence"),
  evidenceDir = null,
} = {}) {
  const explicitDir = evidenceDir ? path.resolve(process.cwd(), evidenceDir) : null;
  const selectedDir = explicitDir || findLatestEvidenceDir(evidenceRoot);
  const result = {
    ok: false,
    generated_at: new Date().toISOString(),
    evidence_root: evidenceRoot,
    evidence_dir: selectedDir,
    evidence_dir_selection: explicitDir ? "explicit" : "latest",
    latest_evidence_dir: explicitDir ? null : selectedDir,
    ext: {},
    poc: [],
    blockers: [],
  };

  if (explicitDir && !fs.existsSync(explicitDir)) {
    result.blockers.push("missing_explicit_evidence_dir");
  } else if (!selectedDir) {
    result.blockers.push("missing_latest_evidence_dir");
  } else {
    const ext001 = readEvidence(selectedDir, ["EXT-001-real-jpyc-payment.md"]);
    const ext002 = readEvidence(selectedDir, ["EXT-002-wallet-device-launch.md", "EXT-002-hashport-device-launch.md"]);
    const ext003 = readEvidence(selectedDir, ["EXT-003-public-fqdn-tls.md"]);
    const ext004 = readEvidence(selectedDir, ["EXT-004-store-ops-drill.md"]);

    result.ext.EXT_001 = {
      file: ext001.file,
      status: ext001.status,
      ...evaluateExt001(ext001),
    };
    result.ext.EXT_002 = {
      file: ext002.file,
      status: ext002.status,
      ...evaluateExt002(ext002),
    };
    result.ext.EXT_003 = {
      file: ext003.file,
      status: ext003.status,
      ...evaluateExt003(ext003),
    };
    result.ext.EXT_004 = {
      file: ext004.file,
      status: ext004.status,
      ...evaluateExt004(ext004),
    };

    for (const [key, value] of Object.entries(result.ext)) {
      if (!value.ok) result.blockers.push(`${key}:${value.errors.join(",")}`);
    }

    result.poc = evaluatePocEvidence(selectedDir);
  }

  result.ext_all_pass = Object.values(result.ext).length > 0 && Object.values(result.ext).every((entry) => entry.ok);
  result.poc_all_pass = result.poc.length === 3 && result.poc.every((entry) => entry.ok);
  result.ok = result.blockers.length === 0;
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const evidenceRoot = path.resolve(process.cwd(), args.get("evidence-root") || "docs/production/evidence");
  const evidenceDir = args.get("evidence-dir") ? path.resolve(process.cwd(), args.get("evidence-dir")) : null;
  const strict = boolFlag(args.get("strict"));
  const result = validateCommercialEvidence({ evidenceRoot, evidenceDir });
  if (args.get("output")) {
    const outputPath = path.resolve(process.cwd(), args.get("output"));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify(result, null, 2));
  if (strict && !result.ok) {
    process.exit(1);
  }
}

const THIS_FILE = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(THIS_FILE)) {
  main();
}
