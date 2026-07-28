import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  apiRequest,
  baseServerEnv,
  createInvoice,
  loginAs,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";
import { buildServiceAuthHeaders } from "./helpers/service-auth.mjs";

const ROOT = process.cwd();
const TOKEN_CONTRACT = "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29";

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of previous.entries()) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

async function loadMonitorModule() {
  const dir = mkdtempSync(path.join(tmpdir(), "jpyc-single-writer-monitor-"));
  const financialDbPath = path.join(dir, "financial.db");
  const workerStateDbPath = path.join(dir, "worker-state.db");
  const env = {
    APP_ENV: "development",
    APP_HOST: "http://127.0.0.1:49997",
    DB_PATH: financialDbPath,
    WORKER_STATE_DB_PATH: workerStateDbPath,
    CHAIN_ID: "137",
    TOKEN_CONTRACT,
    TOKEN_DECIMALS: "18",
    JPYC_BASE_UNIT_SCALE: "1000000",
    RPC_URLS: "http://127.0.0.1:8545",
    REQUIRED_CONFIRMATIONS: "1",
    SERVICE_INGEST_ID: "chain-monitor",
    SERVICE_INGEST_SECRET: "x".repeat(48),
  };
  const entry = pathToFileURL(path.join(ROOT, "src/chain-monitor.mjs")).href;
  const mod = await withEnv(env, () => import(`${entry}?single-writer=${Date.now()}-${Math.random().toString(16).slice(2)}`));
  return { mod, financialDbPath, workerStateDbPath };
}

test("chain worker source has no direct financial table access or financial schema", () => {
  const worker = read("src/chain-monitor.mjs");
  const financialTable = "(?:invoices|payment_events|payment_attempts|receive_addresses|blockchain_transfers|transfer_observations|invoice_transfer_links|review_incidents|settlement_export_rows)";
  assert.match(worker, /WORKER_STATE_DB_PATH/);
  assert.match(worker, /postSignedServiceJson/);
  assert.match(worker, /\/api\/v1\/internal\/chain\/candidates:read/);
  assert.match(worker, /\/api\/v1\/internal\/chain\/payment-evidence:read/);
  assert.match(worker, /\/api\/v1\/internal\/payments\/events:ingest/);
  assert.match(worker, /\/api\/v1\/internal\/chain\/reorgs:ingest/);
  assert.match(worker, /\/api\/v1\/internal\/chain\/reconciliation:ingest/);
  assert.doesNotMatch(worker, new RegExp(`(?:FROM|JOIN|INSERT INTO|UPDATE|DELETE FROM)\\s+${financialTable}`, "i"));
  assert.doesNotMatch(worker, new RegExp(`CREATE TABLE(?: IF NOT EXISTS)?\\s+${financialTable}`, "i"));
  assert.doesNotMatch(worker, /\bDB_PATH\b/);
});

test("production compose grants financial DB only to app and worker state only to worker", () => {
  const compose = read("docker-compose.prod.yml");
  assert.match(compose, /WORKER_STATE_DB_PATH/);
  assert.match(compose, /\.\/runtime\/data:\/app\/runtime\/data/);
  assert.match(compose, /\.\/runtime\/worker-state:\/app\/runtime\/worker-state:ro/);
  assert.match(compose, /\.\/runtime\/worker-state:\/app\/runtime\/worker-state\n/);
  assert.doesNotMatch(compose, /\.\/runtime:\/app\/runtime/);
  assert.match(compose, /process\.env\.WORKER_STATE_DB_PATH/);
});

test("worker creates only operational state in its separate SQLite file", async (t) => {
  const { mod, financialDbPath, workerStateDbPath } = await loadMonitorModule();
  t.after(() => mod.db.close());

  assert.equal(fs.existsSync(financialDbPath), false);
  assert.equal(fs.existsSync(workerStateDbPath), true);

  const stateDb = new Database(workerStateDbPath, { readonly: true, fileMustExist: true });
  t.after(() => stateDb.close());
  const tables = new Set(
    stateDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)
  );
  for (const table of [
    "chain_monitor_state",
    "chain_unmatched_events",
    "chain_dead_letters",
    "chain_rpc_failovers",
    "chain_runtime_registry",
  ]) {
    assert.equal(tables.has(table), true, `${table} must be in worker state DB`);
  }
  for (const table of [
    "invoices",
    "payment_events",
    "payment_attempts",
    "receive_addresses",
    "blockchain_transfers",
    "transfer_observations",
    "invoice_transfer_links",
    "review_incidents",
  ]) {
    assert.equal(tables.has(table), false, `${table} must not be in worker state DB`);
  }
});

test("app keeps signed financial reads/writes at the API boundary and reads worker state separately", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(ROOT, env);
  const appDb = new Database(env.DB_PATH, { readonly: true, fileMustExist: true });
  t.after(async () => {
    appDb.close();
    await stopServerProcess(started.proc);
  });

  const appTables = new Set(
    appDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)
  );
  for (const table of [
    "chain_monitor_state",
    "chain_unmatched_events",
    "chain_dead_letters",
    "chain_rpc_failovers",
    "chain_runtime_registry",
  ]) {
    assert.equal(appTables.has(table), false, `${table} must not be in app financial DB`);
  }

  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
  });
  const created = await createInvoice(started.baseUrl, admin.token, 1234, `single-writer-${Date.now()}`);
  assert.equal(created.status, 201);

  const candidatePayload = { chain_id: "137", token_contract: TOKEN_CONTRACT.toLowerCase() };
  const candidates = await apiRequest(started.baseUrl, "/api/v1/internal/chain/candidates:read", {
    method: "POST",
    headers: buildServiceAuthHeaders(env, candidatePayload, `single-writer-read-${Date.now()}`),
    body: JSON.stringify(candidatePayload),
  });
  assert.equal(candidates.status, 200);
  assert.ok(candidates.data.invoices.some((invoice) => invoice.id === created.data.invoice_id));

  const stateDb = new Database(env.WORKER_STATE_DB_PATH);
  stateDb.exec(`
    CREATE TABLE chain_monitor_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  stateDb.prepare("INSERT INTO chain_monitor_state (key, value, updated_at) VALUES (?, ?, ?)").run(
    "worker:137:last_cycle_at",
    new Date().toISOString(),
    new Date().toISOString(),
  );
  stateDb.close();

  const metrics = await apiRequest(started.baseUrl, "/metrics?format=json", {
    headers: { authorization: `Bearer ${env.METRICS_SECRET}` },
  });
  assert.equal(metrics.status, 200);
  assert.equal(metrics.data.metrics.worker_last_cycle_at != null, true);
});
