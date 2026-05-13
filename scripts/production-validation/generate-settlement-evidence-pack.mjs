#!/usr/bin/env node
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

function toCsv(rows, headers) {
  const sanitize = (value) => {
    const raw = String(value ?? "");
    const first = raw.match(/[^\s]/)?.[0] || "";
    if (["=", "+", "-", "@", "\t", "\r"].includes(first)) return `'${raw}`;
    return raw;
  };
  const escape = (value) => `"${sanitize(value).replace(/"/g, '""')}"`;
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((key) => escape(row[key])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function utcRangeForBusinessDate(date, timezone) {
  const dt = DateTime.fromISO(date, { zone: timezone });
  if (!dt.isValid) return null;
  return {
    fromUtc: dt.startOf("day").toUTC().toISO(),
    toUtc: dt.endOf("day").toUTC().toISO(),
  };
}

function verifyAuditChain(dbPath) {
  const run = spawnSync("node", ["scripts/verify-audit-chain.mjs"], {
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = path.resolve(process.cwd(), args.get("db-path") || process.env.DB_PATH || "./data/app.db");
  const storeId = String(args.get("store-id") || "store-001");
  const timezone = String(args.get("timezone") || "Asia/Tokyo");
  const businessDate = String(args.get("business-date") || DateTime.now().setZone(timezone).toISODate());
  const outputDir = path.resolve(process.cwd(), args.get("output-dir") || `./docs/production/evidence/${DateTime.utc().toFormat("yyyyLLdd'T'HHmmss'Z'")}/settlement-evidence-pack`);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    throw new Error("business-date must be YYYY-MM-DD");
  }
  if (!fs.existsSync(dbPath)) {
    throw new Error(`db path not found: ${dbPath}`);
  }

  const db = new Database(dbPath, { readonly: true });
  const range = utcRangeForBusinessDate(businessDate, timezone);
  if (!range) {
    throw new Error("invalid business date/timezone range");
  }

  const store = db.prepare("SELECT * FROM stores WHERE id = ?").get(storeId);
  if (!store) {
    throw new Error(`store not found: ${storeId}`);
  }

  const invoices = db
    .prepare(
      `SELECT i.id AS invoice_id,
              i.invoice_no,
              i.checkout_session_id,
              i.merchant_id,
              i.store_id,
              i.terminal_id,
              i.operator_id,
              i.event_id,
              i.booth_id,
              i.status AS invoice_status,
              i.status_reason,
              i.amount_jpy,
              i.amount_jpyc_base,
              i.paid_amount_jpyc_base,
              i.paid_tx_hash AS tx_hash,
              i.created_at,
              i.updated_at,
              i.settled_at,
              i.settlement_id,
              r.id AS review_case_id,
              r.reason_type AS reason_code,
              r.status AS review_status,
              r.resolution_status,
              r.block_timestamp,
              r.detected_at,
              r.audit_ref,
              rr.id AS refund_case_id,
              rr.status AS refund_status,
              rr.refund_tx_hash,
              rr.verified_at AS refund_verified_at
       FROM invoices i
       LEFT JOIN review_cases r ON r.invoice_id = i.id
       LEFT JOIN refund_requests rr ON rr.invoice_id = i.id
       WHERE i.store_id = ?
         AND i.created_at BETWEEN ? AND ?
       ORDER BY i.created_at ASC`
    )
    .all(storeId, range.fromUtc, range.toUtc)
    .map((row) => ({
      ...row,
      reason_code: row.reason_code ? normalizeReviewReasonCode(row.reason_code) : null,
    }));

  const paymentAttempts = db
    .prepare(
      `SELECT pa.id,
              pa.invoice_id,
              pa.chain_id,
              pa.tx_hash,
              pa.log_index,
              pa.status,
              pa.source,
              pa.verified_onchain,
              pa.created_at,
              pe.event_type,
              pe.token_contract,
              pe.amount_jpyc,
              pe.amount_jpyc_base,
              pe.confirmations,
              pe.from_address,
              pe.to_address,
              pe.block_number,
              pe.block_timestamp,
              pe.detected_at,
              pe.observed_at
       FROM payment_attempts pa
       JOIN invoices i ON i.id = pa.invoice_id
       LEFT JOIN payment_events pe
              ON pe.invoice_id = pa.invoice_id
             AND pe.tx_hash = pa.tx_hash
             AND COALESCE(pe.log_index, -1) = COALESCE(pa.log_index, -1)
       WHERE i.store_id = ?
         AND i.created_at BETWEEN ? AND ?
       ORDER BY pa.created_at ASC`
    )
    .all(storeId, range.fromUtc, range.toUtc);

  const reviews = db
    .prepare(
      `SELECT r.id AS review_case_id,
              r.invoice_id,
              r.reason_type AS reason_code,
              r.status,
              r.resolution_status,
              r.tx_hash,
              r.billed_amount_jpyc_base,
              r.paid_amount_jpyc_base,
              r.diff_jpyc_base,
              r.suggested_action,
              r.refundable_candidate_jpyc_base,
              r.admin_note,
              r.resolution_note,
              r.assigned_to,
              r.audit_ref,
              r.block_timestamp,
              r.detected_at,
              r.created_at,
              r.updated_at,
              r.resolved_at
       FROM review_cases r
       JOIN invoices i ON i.id = r.invoice_id
       WHERE i.store_id = ?
         AND i.created_at BETWEEN ? AND ?
       ORDER BY r.created_at ASC`
    )
    .all(storeId, range.fromUtc, range.toUtc)
    .map((row) => ({ ...row, reason_code: normalizeReviewReasonCode(row.reason_code) }));

  const refunds = db
    .prepare(
      `SELECT rr.id AS refund_case_id,
              rr.invoice_id AS source_invoice_id,
              rr.review_case_id,
              rr.original_tx_hash,
              rr.refund_tx_hash,
              rr.refund_amount_jpyc,
              rr.refund_amount_jpyc_base,
              rr.reason,
              rr.status,
              rr.requested_by,
              rr.approved_by,
              rr.executed_by,
              rr.verified_at,
              rr.audit_log,
              rr.from_address,
              rr.to_address,
              rr.chain_id,
              rr.token_contract,
              rr.block_number,
              rr.block_timestamp,
              rr.detected_at,
              rr.created_at,
              rr.updated_at
       FROM refund_requests rr
       JOIN invoices i ON i.id = rr.invoice_id
       WHERE i.store_id = ?
         AND i.created_at BETWEEN ? AND ?
       ORDER BY rr.created_at ASC`
    )
    .all(storeId, range.fromUtc, range.toUtc);

  const settlement = db.prepare("SELECT * FROM settlements WHERE store_id = ? AND business_date = ?").get(storeId, businessDate);
  const auditChain = verifyAuditChain(dbPath);

  const summary = {
    generated_at: new Date().toISOString(),
    business_date: businessDate,
    timezone,
    period_start_utc: range.fromUtc,
    period_end_utc: range.toUtc,
    merchant_id: store.merchant_id || "merchant-001",
    store_id: storeId,
    settlement: settlement || null,
    counts: {
      invoices: invoices.length,
      payment_attempts: paymentAttempts.length,
      review_cases: reviews.length,
      refunds: refunds.length,
      paid: invoices.filter((row) => String(row.invoice_status) === "paid").length,
      settled: invoices.filter((row) => String(row.invoice_status) === "settled" || !!row.settled_at).length,
      manual_review: invoices.filter((row) => String(row.invoice_status) === "review_required").length,
      cancelled: invoices.filter((row) => String(row.invoice_status) === "cancelled").length,
      expired: invoices.filter((row) => String(row.invoice_status) === "expired").length,
      refund_requested: refunds.filter((row) => String(row.status) === "requested").length,
      refund_completed: refunds.filter((row) => String(row.status) === "succeeded").length,
    },
    audit_chain_verification: auditChain,
  };

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "settlement-summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(outputDir, "settlement-summary.csv"), toCsv([summary.counts], Object.keys(summary.counts)));
  fs.writeFileSync(path.join(outputDir, "invoices.csv"), toCsv(invoices, [
    "invoice_id",
    "invoice_no",
    "checkout_session_id",
    "merchant_id",
    "store_id",
    "terminal_id",
    "operator_id",
    "event_id",
    "booth_id",
    "invoice_status",
    "status_reason",
    "amount_jpy",
    "amount_jpyc_base",
    "paid_amount_jpyc_base",
    "tx_hash",
    "review_case_id",
    "reason_code",
    "review_status",
    "resolution_status",
    "block_timestamp",
    "detected_at",
    "audit_ref",
    "refund_case_id",
    "refund_status",
    "refund_tx_hash",
    "refund_verified_at",
    "created_at",
    "updated_at",
    "settled_at",
    "settlement_id",
  ]));
  fs.writeFileSync(path.join(outputDir, "payment-attempts.csv"), toCsv(paymentAttempts, [
    "id",
    "invoice_id",
    "status",
    "source",
    "verified_onchain",
    "event_type",
    "tx_hash",
    "log_index",
    "chain_id",
    "token_contract",
    "amount_jpyc",
    "amount_jpyc_base",
    "confirmations",
    "from_address",
    "to_address",
    "block_number",
    "block_timestamp",
    "detected_at",
    "observed_at",
    "created_at",
  ]));
  fs.writeFileSync(path.join(outputDir, "review-cases.csv"), toCsv(reviews, [
    "review_case_id",
    "invoice_id",
    "reason_code",
    "status",
    "resolution_status",
    "tx_hash",
    "billed_amount_jpyc_base",
    "paid_amount_jpyc_base",
    "diff_jpyc_base",
    "suggested_action",
    "refundable_candidate_jpyc_base",
    "admin_note",
    "resolution_note",
    "assigned_to",
    "audit_ref",
    "block_timestamp",
    "detected_at",
    "created_at",
    "updated_at",
    "resolved_at",
  ]));
  fs.writeFileSync(path.join(outputDir, "refunds.csv"), toCsv(refunds, [
    "refund_case_id",
    "source_invoice_id",
    "review_case_id",
    "original_tx_hash",
    "refund_tx_hash",
    "refund_amount_jpyc",
    "refund_amount_jpyc_base",
    "reason",
    "status",
    "requested_by",
    "approved_by",
    "executed_by",
    "verified_at",
    "audit_log",
    "from_address",
    "to_address",
    "chain_id",
    "token_contract",
    "block_number",
    "block_timestamp",
    "detected_at",
    "created_at",
    "updated_at",
  ]));
  fs.writeFileSync(path.join(outputDir, "audit-chain-verification.json"), JSON.stringify(auditChain, null, 2));
  fs.writeFileSync(
    path.join(outputDir, "README.md"),
    [
      "# Settlement Evidence Pack",
      "",
      `- business_date: ${businessDate}`,
      `- timezone: ${timezone}`,
      `- store_id: ${storeId}`,
      `- merchant_id: ${store.merchant_id || "merchant-001"}`,
      `- generated_at: ${summary.generated_at}`,
      "",
      "## Included files",
      "",
      "- settlement-summary.json",
      "- settlement-summary.csv",
      "- invoices.csv",
      "- payment-attempts.csv",
      "- review-cases.csv",
      "- refunds.csv",
      "- audit-chain-verification.json",
      "",
      "## Rules",
      "",
      "- block_timestamp is the on-chain event time used for accounting/legal ordering.",
      "- detected_at is monitor detection time used for SLA/latency tracking.",
      "- reason_code is normalized to canonical JPYC review reason codes.",
    ].join("\n") + "\n"
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        output_dir: outputDir,
        business_date: businessDate,
        store_id: storeId,
        counts: summary.counts,
        audit_chain_ok: auditChain.ok,
      },
      null,
      2
    )
  );
}

main();
