import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import Database from "better-sqlite3";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();

async function getAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function withEnv(overrides, fn) {
  const prev = new Map();
  for (const [k, v] of Object.entries(overrides)) {
    prev.set(k, process.env[k]);
    process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of prev.entries()) {
        if (v == null) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

async function waitForHealth(baseUrl, timeoutMs = 12000) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
      lastError = `status ${res.status}`;
    } catch (_error) {
      lastError = _error?.message || String(_error);
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`server health check timeout for ${baseUrl}; last_error=${lastError || "none"}`);
}

async function request(baseUrl, pathName, options = {}) {
  const res = await fetch(`${baseUrl}${pathName}`, options);
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }
  return { status: res.status, data };
}

test("SR-03 expiry sweeper auto-expires stale invoices and audits changes", async () => {
  const port = await getAvailablePort();
  const tmp = mkdtempSync(path.join(tmpdir(), "jpyc-sweep-test-"));
  const dbPath = path.join(tmp, "app.db");
  const env = {
    APP_ENV: "development",
    APP_PORT: String(port),
    APP_HOST: `http://127.0.0.1:${port}`,
    DB_PATH: dbPath,
    WORKER_STATE_DB_PATH: path.join(tmp, "worker-state.db"),
    APP_SECRET: "s".repeat(48),
    SERVICE_INGEST_SECRET: "t".repeat(48),
    METRICS_SECRET: "u".repeat(48),
    CHAIN_ID: "137",
    TOKEN_CONTRACT: "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
    RECIPIENT_ADDRESS: "0x2222222222222222222222222222222222222222",
    TOKEN_DECIMALS: "18",
    LEDGER_DECIMALS: "6",
    LEDGER_BASE_UNIT_SCALE: "1000000",
    JPYC_BASE_UNIT_SCALE: "1000000",
    RECEIVE_ADDRESS_DEV_AUTO_VERIFY: "true",
    REQUIRED_CONFIRMATIONS: "2",
    MIN_REQUIRED_CONFIRMATIONS: "2",
    STAFF_PIN: "1234",
    SECOND_ADMIN_PIN: "5678",
    TERMINAL_CODE: "TERM-001",
  };

  await withEnv(env, async () => {
    const entry = pathToFileURL(path.join(ROOT, "src/server.mjs")).href;
    const mod = await import(`${entry}?sweep=${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const server = mod.startServer();
    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      await waitForHealth(baseUrl);

      const login = await request(baseUrl, "/api/v1/terminal-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          terminalCode: env.TERMINAL_CODE,
          staffPin: env.STAFF_PIN,
          staffName: "Demo Staff",
        }),
      });
      assert.equal(login.status, 201);
      const token = login.data.token;

      const create1 = await request(baseUrl, "/api/v1/invoices", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": `sweep-inv-1-${Date.now()}`,
        },
        body: JSON.stringify({ amount_jpy: 1000, payment_chain_id: "137" }),
      });
      assert.equal(create1.status, 201);

      const create2 = await request(baseUrl, "/api/v1/invoices", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": `sweep-inv-2-${Date.now()}`,
        },
        body: JSON.stringify({ amount_jpy: 1200, payment_chain_id: "137" }),
      });
      assert.equal(create2.status, 409);
      assert.equal(create2.data.error.code, "TERMINAL_ACTIVE_INVOICE_EXISTS");

      const db = new Database(dbPath);
      try {
        const expiredAt = "2020-01-01T00:00:00.000Z";
        db.prepare(`UPDATE invoices SET expires_at = ?, status = 'issued', updated_at = ? WHERE id = ?`).run(
          expiredAt,
          new Date().toISOString(),
          create1.data.invoice_id
        );

        db.prepare(
          `INSERT INTO payment_events
          (id, invoice_id, event_type, chain_id, tx_hash, log_index, block_number, confirmations, from_address, to_address, token_contract, amount_jpyc, amount_jpyc_base, observed_at, block_timestamp, raw_payload, created_at)
          VALUES (?, ?, 'tx_detected', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          `evt-${Date.now()}`,
          create1.data.invoice_id,
          env.CHAIN_ID,
          "0x" + "9".repeat(64),
          0,
          0,
          2,
          "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          env.RECIPIENT_ADDRESS,
          env.TOKEN_CONTRACT,
          1000,
          "1000000000",
          new Date().toISOString(),
          "2020-01-02T00:00:00.000Z",
          JSON.stringify({ synthetic: true }),
          new Date().toISOString()
        );
      } finally {
        db.close();
      }

      const sweepResult = mod.runInvoiceExpirySweepOnce();
      assert.ok(Number(sweepResult.scanned) >= 1);
      assert.ok(Number(sweepResult.updated) >= 1);

      const invoiceAfter = await request(baseUrl, `/api/v1/invoices/${encodeURIComponent(create1.data.invoice_id)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(invoiceAfter.status, 200);
      assert.equal(invoiceAfter.data.status, "review_required");
      assert.equal(invoiceAfter.data.status_reason, "late_arrival_after_expiry");

      const audit = await request(baseUrl, "/api/v1/audit-logs?limit=100", {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(audit.status, 200);
      const actions = (audit.data.audit_logs || []).map((row) => row.action);
      assert.ok(actions.includes("invoice.auto_expired"));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
