import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  apiRequest,
  baseServerEnv,
  createInvoice,
  loginAs,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();

function claimRequest(baseUrl, publicEntryToken, activeInvoice, deviceId, nonce) {
  return apiRequest(
    baseUrl,
    `/api/v1/public/terminal-entry/${encodeURIComponent(publicEntryToken)}/claim`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anonymous_device_id: deviceId,
        nonce,
        invoice_version: activeInvoice.invoice_version,
        amount_scale_version: activeInvoice.amount_scale_version,
        token_amount_atomic: activeInvoice.token_amount_atomic,
        ledger_amount_base: activeInvoice.ledger_amount_base,
      }),
    },
  );
}

test("expired checkout claim is CAS-expired with audit evidence before exactly one new device wins", async (t) => {
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
  const created = await createInvoice(
    started.baseUrl,
    admin.token,
    1880,
    `claim-expiry-invoice-${Date.now()}`,
  );
  assert.equal(created.status, 201);
  const ready = await apiRequest(
    started.baseUrl,
    `/api/v1/public/terminal-entry/${encodeURIComponent(admin.publicEntryToken)}`,
  );
  assert.equal(ready.status, 200);
  const activeInvoice = ready.data.active_invoice;
  assert.equal(activeInvoice.invoice_id, created.data.invoice_id);

  const original = await claimRequest(
    started.baseUrl,
    admin.publicEntryToken,
    activeInvoice,
    "claim-expiry-device-original",
    "claim-expiry-nonce-original-0001",
  );
  assert.equal(original.status, 201);
  const forcedExpiry = new Date(Date.now() - 1_000).toISOString();
  db.prepare(`UPDATE terminal_checkout_claims SET expires_at = ?, updated_at = ? WHERE id = ?`)
    .run(forcedExpiry, forcedExpiry, original.data.claim_id);

  const contenders = await Promise.all([
    claimRequest(
      started.baseUrl,
      admin.publicEntryToken,
      activeInvoice,
      "claim-expiry-device-contender-a",
      "claim-expiry-nonce-contender-a-0002",
    ),
    claimRequest(
      started.baseUrl,
      admin.publicEntryToken,
      activeInvoice,
      "claim-expiry-device-contender-b",
      "claim-expiry-nonce-contender-b-0003",
    ),
  ]);
  assert.deepEqual(contenders.map((result) => result.status).sort(), [201, 409]);
  const winner = contenders.find((result) => result.status === 201);
  const loser = contenders.find((result) => result.status === 409);
  assert.ok(winner);
  assert.ok(loser);
  assert.equal(loser.data.error.code, "CHECKOUT_ALREADY_CLAIMED");
  assert.notEqual(winner.data.claim_id, original.data.claim_id);

  const claims = db.prepare(
    `SELECT id, status, expires_at FROM terminal_checkout_claims
     WHERE invoice_id = ? ORDER BY created_at ASC, id ASC`
  ).all(created.data.invoice_id);
  assert.equal(claims.length, 2);
  assert.equal(claims.find((claim) => claim.id === original.data.claim_id)?.status, "expired");
  assert.equal(claims.filter((claim) => claim.status === "claimed").length, 1);
  assert.equal(claims.find((claim) => claim.status === "claimed")?.id, winner.data.claim_id);

  const expiryAudits = db.prepare(
    `SELECT after_state FROM audit_logs
     WHERE action = 'terminal.checkout_claim_expired' AND target_type = 'invoice' AND target_id = ?`
  ).all(created.data.invoice_id);
  assert.equal(expiryAudits.length, 1);
  assert.match(String(expiryAudits[0].after_state), new RegExp(original.data.claim_id));
  assert.match(String(expiryAudits[0].after_state), /claim_ttl_elapsed/);

  const staleNonceReplay = await claimRequest(
    started.baseUrl,
    admin.publicEntryToken,
    activeInvoice,
    "claim-expiry-device-original",
    "claim-expiry-nonce-original-0001",
  );
  assert.equal(staleNonceReplay.status, 409);
  assert.equal(staleNonceReplay.data.error.code, "CHECKOUT_CLAIM_EXPIRED");
});
