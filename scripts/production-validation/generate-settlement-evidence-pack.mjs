#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { DateTime } from "luxon";
import { normalizeReviewReasonCode } from "../../src/reason-codes.mjs";

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

function requiredArg(args, name) {
  const value = String(args.get(name) || "").trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function toCsv(rows, headers) {
  const sanitize = (value) => {
    const raw = String(value ?? "");
    const first = raw.match(/[^\s]/)?.[0] || "";
    if (["=", "+", "-", "@", "\t", "\r"].includes(first)) return `'${raw}`;
    return raw;
  };
  const stringify = (value) => {
    if (value == null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  };
  const escape = (value) => `"${sanitize(stringify(value)).replace(/"/g, '""')}"`;
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((key) => escape(row[key])).join(","));
  return `${lines.join("\n")}\n`;
}

function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function verifyAuditChain(dbPath) {
  const run = spawnSync(process.execPath, ["scripts/verify-audit-chain.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, DB_PATH: dbPath },
    encoding: "utf8",
  });
  let payload = null;
  if (run.stdout) {
    try {
      payload = JSON.parse(run.stdout);
    } catch {
      payload = null;
    }
  }
  return {
    ok: run.status === 0 && payload?.ok === true,
    status: run.status === 0 ? "pass" : "fail",
    payload,
    stderr: String(run.stderr || "").trim() || null,
  };
}

function parseFrozenPayload(row, expected) {
  if (!row?.payload_json) {
    throw new Error(`SETTLEMENT_EXPORT_INTEGRITY_ERROR: frozen payload is missing for row ${row?.id || "unknown"}`);
  }
  let payload;
  try {
    payload = JSON.parse(String(row.payload_json));
  } catch (error) {
    throw new Error(`SETTLEMENT_EXPORT_INTEGRITY_ERROR: invalid payload for row ${row.id}: ${error.message}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`SETTLEMENT_EXPORT_INTEGRITY_ERROR: payload must be an object for row ${row.id}`);
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (String(payload[key] ?? "") !== String(expectedValue)) {
      throw new Error(`SETTLEMENT_EXPORT_INTEGRITY_ERROR: ${key} mismatch for row ${row.id}`);
    }
  }
  if (row.evidence_hash && payload.evidence_hash && String(row.evidence_hash) !== String(payload.evidence_hash)) {
    throw new Error(`SETTLEMENT_EXPORT_INTEGRITY_ERROR: evidence_hash mismatch for row ${row.id}`);
  }
  return payload;
}

function addUnique(map, row, idKey = "id") {
  const id = String(row?.[idKey] || "");
  if (!id || map.has(id)) return;
  map.set(id, row);
}

function collectEvidence(rows) {
  const paymentAttempts = new Map();
  const paymentEvents = new Map();
  const reviewIncidents = new Map();
  const reviewIncidentEvents = new Map();
  const refunds = new Map();
  const adjustments = new Map();
  for (const row of rows) {
    const evidence = row.frozen_evidence;
    if (!evidence || typeof evidence !== "object") {
      throw new Error(`SETTLEMENT_EXPORT_INTEGRITY_ERROR: frozen_evidence is missing for row ${row.id}`);
    }
    for (const item of evidence.payment_attempts || []) addUnique(paymentAttempts, { ...item, export_row_id: row.id });
    for (const item of evidence.payment_events || []) addUnique(paymentEvents, { ...item, export_row_id: row.id });
    for (const item of evidence.review_incidents || []) {
      addUnique(reviewIncidents, { ...item, export_row_id: row.id }, "id");
    }
    for (const item of evidence.review_incident_events || []) {
      addUnique(reviewIncidentEvents, { ...item, export_row_id: row.id }, "id");
    }
    for (const item of evidence.refunds || []) addUnique(refunds, { ...item, export_row_id: row.id });
    for (const item of evidence.adjustments || []) addUnique(adjustments, { ...item, export_row_id: row.id });
  }
  return {
    paymentAttempts: [...paymentAttempts.values()],
    paymentEvents: [...paymentEvents.values()],
    reviewIncidents: [...reviewIncidents.values()].map((row) => ({
      ...row,
      reason_code: row.primary_reason ? normalizeReviewReasonCode(row.primary_reason) : null,
    })),
    reviewIncidentEvents: [...reviewIncidentEvents.values()],
    refunds: [...refunds.values()],
    adjustments: [...adjustments.values()],
  };
}

function buildInvoiceRows(rows) {
  const invoices = new Map();
  for (const row of rows) {
    const invoiceId = String(row.invoice_id || "");
    if (!invoiceId) throw new Error(`SETTLEMENT_EXPORT_INTEGRITY_ERROR: invoice_id is missing for row ${row.id}`);
    const existing = invoices.get(invoiceId);
    if (existing) {
      existing.export_row_ids.push(row.id);
      if (row.payment_session_id) existing.payment_session_ids.push(row.payment_session_id);
      continue;
    }
    invoices.set(invoiceId, {
      invoice_id: invoiceId,
      invoice_no: row.invoice_no || null,
      settlement_id: row.settlement_id,
      settlement_export_run_id: row.settlement_export_run_id,
      business_date: row.business_date,
      store_id: row.store_id,
      terminal_id: row.terminal_id,
      operator_id: row.operator_id,
      checkout_session_id: row.checkout_session_id,
      payment_session_ids: row.payment_session_id ? [row.payment_session_id] : [],
      export_row_ids: [row.id],
      invoice_status: row.invoice_status,
      accounting_status: row.accounting_status,
      cash_recognition_status: row.cash_recognition_status,
      receivable_status: row.receivable_status,
      invoice_amount_jpyc_base: String(row.invoice_amount_jpyc_base ?? ""),
      onchain_cash_amount_jpyc_base: String(row.onchain_cash_amount_jpyc_base ?? "0"),
      provider_receivable_amount_jpyc_base: String(row.provider_receivable_amount_jpyc_base ?? "0"),
      exception_amount_jpyc_base: String(row.exception_amount_jpyc_base ?? "0"),
      refund_amount_jpyc_base: String(row.refund_amount_jpyc_base ?? "0"),
      void_amount_jpyc_base: String(row.void_amount_jpyc_base ?? "0"),
      primary_tx_hash: row.primary_tx_hash || null,
      evidence_hashes: [row.evidence_hash].filter(Boolean),
    });
  }
  for (const row of invoices.values()) {
    row.payment_session_ids = [...new Set(row.payment_session_ids)];
    row.export_row_ids = [...new Set(row.export_row_ids)];
    row.evidence_hashes = [...new Set(row.evidence_hashes)];
  }
  return [...invoices.values()];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = path.resolve(process.cwd(), args.get("db-path") || process.env.DB_PATH || "./data/app.db");
  const settlementId = requiredArg(args, "settlement-id");
  const settlementExportRunId = requiredArg(args, "settlement-export-run-id");
  const storeId = String(args.get("store-id") || "store-001");
  const timezone = String(args.get("timezone") || "Asia/Tokyo");
  const businessDate = String(args.get("business-date") || "");
  const outputDir = path.resolve(
    process.cwd(),
    args.get("output-dir") || `./docs/production/evidence/${DateTime.utc().toFormat("yyyyLLdd'T'HHmmss'Z'")}/settlement-evidence-pack`
  );
  if (!businessDate || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    throw new Error("--business-date is required and must be YYYY-MM-DD");
  }
  if (!fs.existsSync(dbPath)) throw new Error(`db path not found: ${dbPath}`);

  const db = new Database(dbPath, { readonly: true });
  try {
    const settlement = db.prepare(`SELECT * FROM settlements WHERE id = ?`).get(settlementId);
    if (!settlement) throw new Error(`settlement not found: ${settlementId}`);
    if (String(settlement.store_id) !== storeId || String(settlement.business_date) !== businessDate) {
      throw new Error("SETTLEMENT_EXPORT_INTEGRITY_ERROR: settlement scope mismatch");
    }
    const exportRun = db.prepare(`SELECT * FROM settlement_export_runs WHERE id = ?`).get(settlementExportRunId);
    if (!exportRun) throw new Error(`settlement export run not found: ${settlementExportRunId}`);
    if (String(exportRun.settlement_id || "") !== settlementId
      || String(exportRun.store_id || "") !== storeId
      || String(exportRun.business_date || "") !== businessDate) {
      throw new Error("SETTLEMENT_EXPORT_INTEGRITY_ERROR: export run is not bound to settlement scope");
    }
    if (String(exportRun.status || "") !== "completed") {
      throw new Error(`SETTLEMENT_EXPORT_INTEGRITY_ERROR: export run is not completed (${exportRun.status})`);
    }

    const storedRows = db.prepare(
      `SELECT * FROM settlement_export_rows
       WHERE export_run_id = ?
       ORDER BY COALESCE(invoice_id, ''), COALESCE(payment_session_id, ''), id`
    ).all(settlementExportRunId);
    const rows = storedRows.map((row) => parseFrozenPayload(row, {
      settlement_id: settlementId,
      settlement_export_run_id: settlementExportRunId,
      export_run_id: settlementExportRunId,
      business_date: businessDate,
      store_id: storeId,
    }));
    const invoices = buildInvoiceRows(rows);
    const evidence = collectEvidence(rows);
    const auditChain = verifyAuditChain(dbPath);
    const generatedAt = new Date().toISOString();
    const summary = {
      generated_at: generatedAt,
      contract_version: String(exportRun.export_version || "v2"),
      business_date: businessDate,
      timezone,
      settlement_id: settlementId,
      settlement_export_run_id: settlementExportRunId,
      store_id: storeId,
      merchant_id: settlement.merchant_id || null,
      source: "settlement_export_rows.payload_json",
      counts: {
        export_rows: rows.length,
        invoices: invoices.length,
        payment_attempts: evidence.paymentAttempts.length,
        payment_events: evidence.paymentEvents.length,
        review_incidents: evidence.reviewIncidents.length,
        review_incident_events: evidence.reviewIncidentEvents.length,
        refunds: evidence.refunds.length,
        adjustments: evidence.adjustments.length,
        paid: invoices.filter((row) => ["paid", "settled"].includes(String(row.invoice_status))).length,
        review_required: invoices.filter((row) => String(row.invoice_status) === "review_required").length,
      },
      settlement_snapshot: {
        id: settlement.id,
        created_at: settlement.created_at,
        snapshot_hash: settlement.snapshot_hash || null,
        audit_root: settlement.audit_root || null,
        close_status: settlement.close_status || null,
      },
      audit_chain_verification: auditChain,
    };

    fs.mkdirSync(outputDir, { recursive: true });
    const files = new Map();
    const writeText = (name, content) => {
      fs.writeFileSync(path.join(outputDir, name), content);
      files.set(name, { bytes: Buffer.byteLength(content), sha256: sha256Bytes(Buffer.from(content)) });
    };
    const writeJson = (name, value) => writeText(name, `${JSON.stringify(value, null, 2)}\n`);

    writeJson("settlement-summary.json", summary);
    writeText("settlement-summary.csv", toCsv([summary.counts], Object.keys(summary.counts)));
    writeText("invoices.csv", toCsv(invoices, [
      "invoice_id", "invoice_no", "settlement_id", "settlement_export_run_id", "business_date", "store_id",
      "terminal_id", "operator_id", "checkout_session_id", "payment_session_ids", "export_row_ids",
      "invoice_status", "accounting_status", "cash_recognition_status", "receivable_status",
      "invoice_amount_jpyc_base", "onchain_cash_amount_jpyc_base", "provider_receivable_amount_jpyc_base",
      "exception_amount_jpyc_base", "refund_amount_jpyc_base", "void_amount_jpyc_base", "primary_tx_hash",
      "evidence_hashes",
    ]));
    writeText("payment-attempts.csv", toCsv(evidence.paymentAttempts, [
      "id", "export_row_id", "chain_id", "tx_hash", "log_index", "status", "source", "verified_onchain",
      "amount_scale_version", "token_decimals", "ledger_decimals", "token_amount_atomic", "ledger_amount_base",
      "display_amount", "block_number", "block_hash", "block_timestamp", "confirmations", "canonical_status",
      "recognition_status", "payload_hash", "created_at",
    ]));
    writeText("payment-events.csv", toCsv(evidence.paymentEvents, [
      "id", "export_row_id", "event_type", "chain_id", "tx_hash", "log_index", "block_number", "confirmations",
      "token_contract", "amount_atomic", "ledger_amount_base", "display_amount", "canonical_status",
      "recognition_status", "observed_at", "block_hash", "block_timestamp", "detected_at", "raw_payload_hash",
      "created_at",
    ]));
    writeText("review-incidents.csv", toCsv(evidence.reviewIncidents, [
      "id", "export_row_id", "invoice_version", "incident_type", "evidence_fingerprint", "primary_reason",
      "reason_code", "status", "resolution_status", "disposition", "created_at",
    ]));
    writeText("refunds.csv", toCsv(evidence.refunds, [
      "id", "export_row_id", "review_case_id", "refund_case_id", "invoice_id", "original_invoice_id",
      "checkout_session_id", "original_tx_hash", "reason", "requested_by", "approved_by", "status",
      "refund_amount_jpyc_base", "refund_to_address", "refund_chain_id", "refund_tx_hash", "refund_tx_log_index",
      "blockchain_transfer_id", "executed_by", "executor_type", "execution_ref", "chain_id", "token_contract",
      "block_number", "block_timestamp", "finality_confirmations", "finality_required_confirmations",
      "canonical_status", "reorg_hold", "finalized_at", "detected_at", "verified_at", "audit_log_refs",
      "created_at", "updated_at",
    ]));
    writeText("adjustments.csv", toCsv(evidence.adjustments, [
      "id", "export_row_id", "related_review_case_id", "adjustment_type", "amount_jpyc_base", "reason",
      "created_by", "approved_by", "status", "created_at", "approved_at", "evidence_hash",
    ]));
    writeJson("audit-chain-verification.json", auditChain);
    writeText("README.md", [
      "# Settlement Evidence Pack",
      "",
      `- settlement_id: ${settlementId}`,
      `- settlement_export_run_id: ${settlementExportRunId}`,
      `- business_date: ${businessDate}`,
      `- store_id: ${storeId}`,
      "- source: settlement_export_rows.payload_json",
      "- live business-table joins: none",
      "",
      "The pack is generated from the immutable settlement export snapshot. Missing or corrupt frozen payloads fail closed.",
      "",
    ].join("\n"));

    const manifest = {
      manifest_version: "settlement-evidence-manifest-v1",
      generated_at: generatedAt,
      settlement_id: settlementId,
      settlement_export_run_id: settlementExportRunId,
      business_date: businessDate,
      store_id: storeId,
      contract_version: String(exportRun.export_version || "v2"),
      source: {
        table: "settlement_export_rows",
        frozen_payload_column: "payload_json",
        row_ids: storedRows.map((row) => row.id),
        evidence_hashes: [...new Set(rows.map((row) => row.evidence_hash).filter(Boolean))],
      },
      migration: {
        live_joins_used: false,
        live_business_tables_used_for_outputs: false,
        legacy_review_cases_used: false,
      },
      audit_anchor: {
        status: settlement.audit_root ? "present" : "missing",
        settlement_audit_root: settlement.audit_root || null,
        settlement_snapshot_hash: settlement.snapshot_hash || null,
        audit_chain_verification: auditChain,
      },
      signature: {
        status: "not_present",
        algorithm: null,
        value: null,
        note: "No external signature was invented; attach the approved signature at release packaging time.",
      },
      files: {
        ...Object.fromEntries(files),
        "manifest.json": { bytes: null, sha256: null, self_digest: "excluded" },
      },
    };
    writeJson("manifest.json", manifest);

    console.log(JSON.stringify({
      ok: true,
      output_dir: outputDir,
      settlement_id: settlementId,
      settlement_export_run_id: settlementExportRunId,
      business_date: businessDate,
      store_id: storeId,
      counts: summary.counts,
      audit_chain_ok: auditChain.ok,
      manifest: path.join(outputDir, "manifest.json"),
    }, null, 2));
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(String(error?.message || error));
  process.exitCode = 1;
}
