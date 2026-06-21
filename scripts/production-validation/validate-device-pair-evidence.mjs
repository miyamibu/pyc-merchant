#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const OFFICIAL_CONTRACT = "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29";

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

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function isHttpsOrigin(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" && !["localhost", "127.0.0.1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function hasAttestation(value) {
  return Boolean(value && typeof value === "object" && String(value.name || value.operator || value.reviewer || "").trim());
}

function statusIsPass(value) {
  return String(value || "").trim().toLowerCase() === "pass";
}

function validateMedia({ evidenceDir, releaseWindowStart, releaseWindowEnd, media = [] }) {
  const errors = [];
  for (const [index, item] of media.entries()) {
    const rel = String(item.relative_path || "").trim();
    if (!rel || rel.includes("..") || path.isAbsolute(rel)) {
      errors.push(`media_${index}_invalid_relative_path`);
      continue;
    }
    const fullPath = path.resolve(evidenceDir, rel);
    if (!fullPath.startsWith(`${path.resolve(evidenceDir)}${path.sep}`)) {
      errors.push(`media_${index}_path_outside_evidence_dir`);
      continue;
    }
    let stat = null;
    try {
      stat = fs.lstatSync(fullPath);
    } catch {
      errors.push(`media_${index}_missing_file`);
      continue;
    }
    if (!stat.isFile()) errors.push(`media_${index}_not_regular_file`);
    if (stat.isSymbolicLink()) errors.push(`media_${index}_symlink`);
    if (stat.size <= 0) errors.push(`media_${index}_zero_byte`);
    if (Number(item.byte_size) !== stat.size) errors.push(`media_${index}_byte_size_mismatch`);
    if (String(item.sha256 || "").toLowerCase() !== sha256File(fullPath)) errors.push(`media_${index}_sha256_mismatch`);
    const captured = Date.parse(item.captured_at || "");
    if (!Number.isFinite(captured)) {
      errors.push(`media_${index}_invalid_captured_at`);
    } else {
      const now = Date.now();
      if (captured > now) errors.push(`media_${index}_captured_at_future`);
      if (releaseWindowStart && captured < releaseWindowStart) errors.push(`media_${index}_captured_at_before_release_window`);
      if (releaseWindowEnd && captured > releaseWindowEnd) errors.push(`media_${index}_captured_at_after_release_window`);
    }
    for (const key of ["mime_type", "device_role", "scenario_id"]) {
      if (!String(item[key] || "").trim()) errors.push(`media_${index}_missing_${key}`);
    }
  }
  return errors;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const evidenceDir = path.resolve(process.cwd(), args.get("evidence-dir") || "");
  const manifestPath = path.join(evidenceDir, "DEVICE-PAIR-001-connected-ipad-iphone.json");
  const errors = [];
  if (!args.get("evidence-dir")) errors.push("missing_evidence_dir_arg");
  if (!fs.existsSync(manifestPath)) errors.push("missing_device_pair_manifest");

  let manifest = {};
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      errors.push("invalid_device_pair_json");
    }
  }

  const releaseWindowStart = Date.parse(manifest.release_window_start || manifest.generated_at || "");
  const releaseWindowEnd = Date.parse(manifest.release_window_end || "");
  if (manifest.schema_version !== "1.0.0") errors.push("schema_version_must_be_1.0.0");
  if (!String(manifest.release_id || "").trim()) errors.push("missing_release_id");
  if (!/^https:\/\//i.test(String(manifest.origin || "")) || !isHttpsOrigin(manifest.origin)) errors.push("origin_must_be_public_https");
  const enabledChainIds = Array.isArray(manifest.enabled_chain_ids) ? manifest.enabled_chain_ids.map(String) : [];
  if (!enabledChainIds.includes("137")) errors.push("enabled_chain_ids_must_include_137");
  if (String(manifest.contract_address || "").toLowerCase() !== OFFICIAL_CONTRACT) errors.push("contract_address_must_match_official_jpyc");

  const merchant = manifest.devices?.merchant_ipad || {};
  const customer = manifest.devices?.customer_iphone || {};
  if (merchant.orientation !== "landscape") errors.push("merchant_ipad_orientation_must_be_landscape");
  if (customer.orientation !== "portrait") errors.push("customer_iphone_orientation_must_be_portrait");
  for (const [role, device] of [["merchant_ipad", merchant], ["customer_iphone", customer]]) {
    for (const key of ["detected", "paired", "reachable"]) {
      if (device[key] !== true) errors.push(`${role}_${key}_not_true`);
    }
  }

  const capabilities = manifest.capabilities || {};
  if (!["not_implemented", "pending", "pass", "fail"].includes(String(capabilities.walletconnect_transaction_session || ""))) {
    errors.push("walletconnect_transaction_session_invalid");
  }
  const scenarios = manifest.scenarios || {};
  for (const key of ["ipad_login", "invoice_create", "qr_render", "iphone_qr_scan", "payment_page_render", "manual_copy_fallback"]) {
    if (!statusIsPass(scenarios[key])) errors.push(`scenario_${key}_not_pass`);
  }
  if (!hasAttestation(manifest.operator_attestation)) errors.push("missing_operator_attestation");
  if (!hasAttestation(manifest.reviewer_attestation)) errors.push("missing_reviewer_attestation");
  errors.push(...validateMedia({
    evidenceDir,
    releaseWindowStart: Number.isFinite(releaseWindowStart) ? releaseWindowStart : null,
    releaseWindowEnd: Number.isFinite(releaseWindowEnd) ? releaseWindowEnd : null,
    media: Array.isArray(manifest.media) ? manifest.media : [],
  }));

  const devicePairOk = errors.length === 0;
  const walletconnectOk = statusIsPass(capabilities.walletconnect_transaction_session);
  const pilotOk = devicePairOk && statusIsPass(capabilities.manual_copy_fallback);
  const commercialOk = pilotOk && walletconnectOk && statusIsPass(capabilities.hashport_deeplink) && statusIsPass(capabilities.eip681_uri);
  const result = {
    ok: devicePairOk,
    generated_at: new Date().toISOString(),
    evidence_dir: evidenceDir,
    manifest: manifestPath,
    device_pair_ok: devicePairOk,
    ext002_pilot_ok: pilotOk,
    ext002_commercial_ok: commercialOk,
    errors,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(devicePairOk ? 0 : 1);
}

main();
