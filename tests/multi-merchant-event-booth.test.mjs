import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  createInvoice,
  getInvoice,
  ingestManualPayment,
  loginAs,
  randomTxHash,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();

test("multi-merchant/event/booth schema exists and settlement export enforces role permissions", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(CWD, env);
  const db = new Database(env.DB_PATH);

  t.after(async () => {
    db.close();
    await stopServerProcess(started.proc);
  });

  const requiredTables = [
    "merchants",
    "stores",
    "terminals",
    "staff_users",
    "role_permissions",
    "events",
    "booths",
    "settlement_exports",
    "invoice_lineage",
  ];

  for (const table of requiredTables) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    assert.equal(row?.name, table);
  }

  const defaultStore = db.prepare("SELECT id, merchant_id FROM stores WHERE id = 'store-001'").get();
  assert.equal(defaultStore.id, "store-001");
  assert.equal(defaultStore.merchant_id, "merchant-001");

  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
  });

  const invoice = await createInvoice(started.baseUrl, admin.token, 1700, `multi-merchant-${Date.now()}`);
  assert.equal(invoice.status, 201);
  const detail = await getInvoice(started.baseUrl, admin.token, invoice.data.invoice_id);
  const paid = await ingestManualPayment(started.baseUrl, admin.token, {
    invoice_id: invoice.data.invoice_id,
    amount_jpyc_base: detail.data.amounts.amount_jpyc_base,
    chain_id: env.CHAIN_ID,
    token_contract: env.TOKEN_CONTRACT,
    to_address: detail.data.chain.recipient_address,
    confirmations: 2,
    tx_hash: randomTxHash("multi-merchant-paid"),
    from_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }, `multi-merchant-paid-${Date.now()}`);
  assert.equal(paid.status, 200);

  const businessDateJst = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const exportJson = await apiRequest(
    started.baseUrl,
    `/api/v1/settlements/daily:export?business_date=${encodeURIComponent(businessDateJst)}&format=json`,
    { headers: authHeaders(admin.token) }
  );
  assert.equal(exportJson.status, 200);
  assert.ok(Array.isArray(exportJson.data.rows));
  const row = exportJson.data.rows.find((r) => r.invoice_id === invoice.data.invoice_id);
  assert.ok(row);
  assert.equal(row.merchant_id, "merchant-001");
  assert.equal(row.store_id, "store-001");

  const createStaff = await apiRequest(started.baseUrl, "/api/v1/staff", {
    method: "POST",
    headers: authHeaders(admin.token, {
      "content-type": "application/json",
      "idempotency-key": `staff-settlement-perm-${Date.now()}`,
    }),
    body: JSON.stringify({
      staff_name: "Floor Staff",
      role: "staff",
      pin: "2468",
      status: "active",
    }),
  });
  assert.equal(createStaff.status, 201);

  const staff = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: "2468",
    staffName: "Floor Staff",
  });

  const exportBlocked = await apiRequest(
    started.baseUrl,
    `/api/v1/settlements/daily:export?business_date=${encodeURIComponent(businessDateJst)}&format=csv`,
    { headers: authHeaders(staff.token) }
  );
  assert.equal(exportBlocked.status, 403);
});
