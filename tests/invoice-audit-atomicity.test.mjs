import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  createInvoice,
  loginAs,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();

function jsonHeaders(token, idempotencyKey) {
  return authHeaders(token, {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  });
}

async function importAddresses(baseUrl, token, addresses) {
  return apiRequest(baseUrl, "/api/v1/admin/receive-addresses:import", {
    method: "POST",
    headers: jsonHeaders(token, `atomic-address-import-${Date.now()}-${addresses.length}`),
    body: JSON.stringify({ source_label: "audit_atomicity_fixture", addresses }),
  });
}

function businessCounts(db) {
  return {
    invoices: db.prepare(`SELECT COUNT(*) AS count FROM invoices`).get().count,
    checkoutSessions: db.prepare(`SELECT COUNT(*) AS count FROM checkout_sessions`).get().count,
    paymentSessions: db.prepare(`SELECT COUNT(*) AS count FROM payment_sessions`).get().count,
    lineages: db.prepare(`SELECT COUNT(*) AS count FROM invoice_lineage`).get().count,
  };
}

function installAuditFailureTrigger(db, action) {
  db.exec(
    `CREATE TRIGGER test_required_audit_failure
     BEFORE INSERT ON audit_logs
     WHEN NEW.action = '${action}'
     BEGIN
       SELECT RAISE(ABORT, 'injected required audit failure');
     END;`
  );
}

function removeAuditFailureTrigger(db) {
  db.exec(`DROP TRIGGER test_required_audit_failure`);
}

function assertRetryableIdempotencyClaim(db, endpoint, idempotencyKey) {
  const claim = db.prepare(
    `SELECT status, status_code, response_json, response_status, lease_owner, lease_expires_at
     FROM idempotency_records
     WHERE endpoint = ? AND idempotency_key = ?`
  ).get(endpoint, idempotencyKey);
  assert.ok(claim);
  assert.equal(claim.status, "in_progress");
  assert.equal(claim.status_code, 0);
  assert.equal(claim.response_json, JSON.stringify({ _idempotency_state: "pending" }));
  assert.equal(claim.response_status, null);
  assert.equal(claim.lease_owner, null);
  assert.equal(claim.lease_expires_at, null);
}

test("invoice create rolls every business write back when its required audit append fails", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(CWD, env);
  const db = new Database(env.DB_PATH);
  t.after(async () => {
    db.close();
    await stopServerProcess(started.proc);
  });
  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });
  const imported = await importAddresses(
    started.baseUrl,
    admin.token,
    ["0x5100000000000000000000000000000000000001"],
  );
  assert.equal(imported.status, 201);
  const before = businessCounts(db);
  const pointerBefore = db.prepare(`SELECT current_invoice_id FROM terminals WHERE id = ?`).get(admin.terminalId);
  const addressBefore = db.prepare(`SELECT id, status, allocated_invoice_id FROM receive_addresses`).get();
  const pointerAuditBefore = db.prepare(
    `SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'terminal.current_invoice.assigned'`
  ).get().count;
  const idempotencyKey = `invoice-audit-failure-${Date.now()}`;

  installAuditFailureTrigger(db, "invoice.created");
  const failed = await createInvoice(started.baseUrl, admin.token, 1250, idempotencyKey);
  assert.equal(failed.status, 500);
  assert.equal(failed.data.error.code, "INTERNAL_ERROR");
  assert.deepEqual(businessCounts(db), before);
  assert.deepEqual(
    db.prepare(`SELECT current_invoice_id FROM terminals WHERE id = ?`).get(admin.terminalId),
    pointerBefore,
  );
  assert.deepEqual(
    db.prepare(`SELECT id, status, allocated_invoice_id FROM receive_addresses WHERE id = ?`).get(addressBefore.id),
    addressBefore,
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'invoice.created'`).get().count,
    0,
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'terminal.current_invoice.assigned'`).get().count,
    pointerAuditBefore,
  );
  assertRetryableIdempotencyClaim(db, "POST:/api/v1/invoices", idempotencyKey);

  removeAuditFailureTrigger(db);
  const retried = await createInvoice(started.baseUrl, admin.token, 1250, idempotencyKey);
  assert.equal(retried.status, 201);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM invoices`).get().count, before.invoices + 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM checkout_sessions`).get().count, before.checkoutSessions + 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM payment_sessions`).get().count, before.paymentSessions + 1);
  assert.equal(
    db.prepare(`SELECT current_invoice_id FROM terminals WHERE id = ?`).get(admin.terminalId).current_invoice_id,
    retried.data.invoice_id,
  );
  assert.equal(
    db.prepare(`SELECT allocated_invoice_id FROM receive_addresses WHERE id = ?`).get(addressBefore.id).allocated_invoice_id,
    retried.data.invoice_id,
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'invoice.created' AND target_id = ?`).get(retried.data.invoice_id).count,
    1,
  );
});

test("invoice reissue restores the original invoice, pointer, lineage, sessions, and address on required-audit failure", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(CWD, env);
  const db = new Database(env.DB_PATH);
  t.after(async () => {
    db.close();
    await stopServerProcess(started.proc);
  });
  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });
  const imported = await importAddresses(
    started.baseUrl,
    admin.token,
    [
      "0x5200000000000000000000000000000000000001",
      "0x5200000000000000000000000000000000000002",
    ],
  );
  assert.equal(imported.status, 201);
  const original = await createInvoice(started.baseUrl, admin.token, 1400, `reissue-original-${Date.now()}`);
  assert.equal(original.status, 201);
  const before = businessCounts(db);
  const originalBefore = db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(original.data.invoice_id);
  const pointerBefore = db.prepare(
    `SELECT current_invoice_id, current_invoice_assigned_at FROM terminals WHERE id = ?`
  ).get(admin.terminalId);
  const addressesBefore = db.prepare(
    `SELECT id, status, allocated_invoice_id, allocated_at FROM receive_addresses ORDER BY address ASC`
  ).all();
  const reissueAuditBefore = db.prepare(
    `SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'invoice.reissued'`
  ).get().count;
  const idempotencyKey = `reissue-audit-failure-${Date.now()}`;

  installAuditFailureTrigger(db, "invoice.reissued");
  const failed = await apiRequest(
    started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(original.data.invoice_id)}/reissue`,
    { method: "POST", headers: jsonHeaders(admin.token, idempotencyKey), body: "{}" },
  );
  assert.equal(failed.status, 500);
  assert.equal(failed.data.error.code, "INTERNAL_ERROR");
  assert.deepEqual(businessCounts(db), before);
  assert.deepEqual(db.prepare(`SELECT * FROM invoices WHERE id = ?`).get(original.data.invoice_id), originalBefore);
  assert.deepEqual(
    db.prepare(`SELECT current_invoice_id, current_invoice_assigned_at FROM terminals WHERE id = ?`).get(admin.terminalId),
    pointerBefore,
  );
  assert.deepEqual(
    db.prepare(`SELECT id, status, allocated_invoice_id, allocated_at FROM receive_addresses ORDER BY address ASC`).all(),
    addressesBefore,
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'invoice.reissued'`).get().count,
    reissueAuditBefore,
  );
  assertRetryableIdempotencyClaim(db, "POST:/api/v1/invoices/:id/reissue", idempotencyKey);

  removeAuditFailureTrigger(db);
  const retried = await apiRequest(
    started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(original.data.invoice_id)}/reissue`,
    { method: "POST", headers: jsonHeaders(admin.token, idempotencyKey), body: "{}" },
  );
  assert.equal(retried.status, 201, JSON.stringify(retried.data));
  assert.equal(db.prepare(`SELECT status FROM invoices WHERE id = ?`).get(original.data.invoice_id).status, "expired");
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM invoices`).get().count, before.invoices + 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM checkout_sessions`).get().count, before.checkoutSessions);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM payment_sessions`).get().count, before.paymentSessions + 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM invoice_lineage`).get().count, before.lineages + 1);
  assert.equal(
    db.prepare(`SELECT current_invoice_id FROM terminals WHERE id = ?`).get(admin.terminalId).current_invoice_id,
    retried.data.invoice_id,
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM receive_addresses WHERE status = 'allocated'`).get().count,
    2,
  );
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'invoice.reissued' AND target_id = ?`).get(retried.data.invoice_id).count,
    1,
  );
});
