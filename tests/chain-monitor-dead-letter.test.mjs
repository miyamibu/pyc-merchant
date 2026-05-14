import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();

test("chain monitor caches block timestamps per block within a scan cycle", () => {
  const source = readFileSync(path.join(ROOT, "src/chain-monitor.mjs"), "utf8");
  assert.match(source, /const blockTimestampCache = new Map\(\)/);
  assert.match(source, /blockTimestampCache\.has\(normalizedBlockNumber\)/);
  assert.match(source, /blockTimestampIso\(log\.blockNumber\)/);
});

test("missing block timestamp dead letters keep recoverable ingest payload", () => {
  const source = readFileSync(path.join(ROOT, "src/chain-monitor.mjs"), "utf8");
  assert.match(source, /reason: "missing_block_timestamp"/);
  for (const field of [
    "invoice_id",
    "amount_jpyc_base",
    "amount_jpyc",
    "chain_id",
    "token_contract",
    "to_address",
    "from_address",
    "confirmations",
    "source: \"chain_monitor\"",
    "missing_fields: \\[\"block_timestamp\"\\]",
  ]) {
    assert.match(source, new RegExp(field));
  }
  assert.match(source, /recoveredBlockTimestamp = await blockTimestampIso\(payload\.block_number\)/);
});

function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, prev] of previous.entries()) {
        if (prev == null) delete process.env[key];
        else process.env[key] = prev;
      }
    });
}

async function loadMonitorModule(extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "jpyc-monitor-test-"));
  const env = {
    APP_ENV: "development",
    APP_HOST: "http://127.0.0.1:49999",
    DB_PATH: path.join(dir, "monitor.db"),
    CHAIN_ID: "137",
    TOKEN_CONTRACT: "0x1111111111111111111111111111111111111111",
    TOKEN_DECIMALS: "6",
    JPYC_BASE_UNIT_SCALE: "1000000",
    RPC_URLS: "http://127.0.0.1:8545",
    REQUIRED_CONFIRMATIONS: "1",
    SERVICE_INGEST_ID: "chain-monitor",
    SERVICE_INGEST_SECRET: "x".repeat(48),
    MONITOR_DEAD_LETTER_MAX_RETRIES: "2",
    MONITOR_DEAD_LETTER_RETRY_INTERVAL_MS: "1000",
    ...extraEnv,
  };
  return withEnv(env, async () => {
    const entry = pathToFileURL(path.join(ROOT, "src/chain-monitor.mjs")).href;
    return import(`${entry}?dl=${Date.now()}-${Math.random().toString(16).slice(2)}`);
  });
}

test("SR-07 dead-letter upsert dedupes by tx/log/invoice and increments retry_count", async () => {
  const mod = await loadMonitorModule();
  mod.db.prepare(`DELETE FROM chain_dead_letters`).run();

  mod.upsertDeadLetter({
    chainId: "137",
    txHash: "0x" + "a".repeat(64),
    logIndex: 5,
    invoiceId: "inv-1",
    payload: { hello: "a" },
    reason: "ingest_failed_1",
  });
  mod.upsertDeadLetter({
    chainId: "137",
    txHash: "0x" + "a".repeat(64),
    logIndex: 5,
    invoiceId: "inv-1",
    payload: { hello: "b" },
    reason: "ingest_failed_2",
  });

  const count = mod.db.prepare(`SELECT COUNT(*) AS c FROM chain_dead_letters`).get();
  assert.equal(Number(count.c), 1);
  const row = mod.db.prepare(`SELECT retry_count, reason, status FROM chain_dead_letters`).get();
  assert.equal(Number(row.retry_count), 2);
  assert.equal(row.reason, "ingest_failed_2");
  assert.equal(row.status, "pending");
});

test("SR-07 dead-letter retry success resolves pending rows", async () => {
  const mod = await loadMonitorModule();
  mod.db.prepare(`DELETE FROM chain_dead_letters`).run();
  mod.upsertDeadLetter({
    chainId: "137",
    txHash: "0x" + "b".repeat(64),
    logIndex: 1,
    invoiceId: "inv-2",
    payload: {
      invoice_id: "inv-2",
      amount_jpyc: "1000",
      chain_id: "137",
      token_contract: "0x1111111111111111111111111111111111111111",
      to_address: "0x2222222222222222222222222222222222222222",
      confirmations: 1,
      tx_hash: "0x" + "b".repeat(64),
    },
    reason: "ingest_failed",
  });
  mod.db.prepare(`UPDATE chain_dead_letters SET next_retry_at = ?`).run(new Date(Date.now() - 1000).toISOString());

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true }),
  });
  try {
    await mod.retryPendingDeadLetters();
  } finally {
    global.fetch = originalFetch;
  }

  const row = mod.db.prepare(`SELECT status, resolved_at, retry_count FROM chain_dead_letters`).get();
  assert.equal(row.status, "resolved");
  assert.ok(row.resolved_at);
  assert.ok(Number(row.retry_count) >= 1);
});

test("SR-07 dead-letter retry abandons after max retries", async () => {
  const mod = await loadMonitorModule({ MONITOR_DEAD_LETTER_MAX_RETRIES: "2" });
  mod.db.prepare(`DELETE FROM chain_dead_letters`).run();
  mod.upsertDeadLetter({
    chainId: "137",
    txHash: "0x" + "c".repeat(64),
    logIndex: 2,
    invoiceId: "inv-3",
    payload: {
      invoice_id: "inv-3",
      amount_jpyc: "1000",
      chain_id: "137",
      token_contract: "0x1111111111111111111111111111111111111111",
      to_address: "0x2222222222222222222222222222222222222222",
      confirmations: 1,
      tx_hash: "0x" + "c".repeat(64),
    },
    reason: "ingest_failed",
  });
  mod.db
    .prepare(`UPDATE chain_dead_letters SET retry_count = 1, next_retry_at = ? WHERE tx_hash = ?`)
    .run(new Date(Date.now() - 1000).toISOString(), "0x" + "c".repeat(64));

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 500,
    text: async () => JSON.stringify({ error: { message: "boom" } }),
  });
  try {
    await mod.retryPendingDeadLetters();
  } finally {
    global.fetch = originalFetch;
  }

  const row = mod.db
    .prepare(`SELECT status, retry_count, resolved_at, last_error FROM chain_dead_letters WHERE tx_hash = ?`)
    .get("0x" + "c".repeat(64));
  assert.equal(row.status, "abandoned");
  assert.equal(Number(row.retry_count), 2);
  assert.ok(row.resolved_at);
  assert.match(String(row.last_error || ""), /ingest_failed/i);
});

test("SR-07 dead-letter transient retry failure stays pending until max retries", async () => {
  const mod = await loadMonitorModule({ MONITOR_DEAD_LETTER_MAX_RETRIES: "3" });
  mod.db.prepare(`DELETE FROM chain_dead_letters`).run();
  mod.upsertDeadLetter({
    chainId: "137",
    txHash: "0x" + "d".repeat(64),
    logIndex: 3,
    invoiceId: "inv-4",
    payload: {
      invoice_id: "inv-4",
      amount_jpyc: "1000",
      chain_id: "137",
      token_contract: "0x1111111111111111111111111111111111111111",
      to_address: "0x2222222222222222222222222222222222222222",
      confirmations: 1,
      tx_hash: "0x" + "d".repeat(64),
    },
    reason: "ingest_failed",
  });
  mod.db.prepare(`UPDATE chain_dead_letters SET next_retry_at = ?`).run(new Date(Date.now() - 1000).toISOString());

  const before = mod.db
    .prepare(`SELECT retry_count, next_retry_at FROM chain_dead_letters WHERE tx_hash = ?`)
    .get("0x" + "d".repeat(64));

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 504,
    text: async () => JSON.stringify({ error: { message: "timeout" } }),
  });
  try {
    await mod.retryPendingDeadLetters();
  } finally {
    global.fetch = originalFetch;
  }

  const row = mod.db
    .prepare(`SELECT status, retry_count, resolved_at, last_error, next_retry_at FROM chain_dead_letters WHERE tx_hash = ?`)
    .get("0x" + "d".repeat(64));
  assert.equal(row.status, "pending");
  assert.equal(Number(row.retry_count), Number(before.retry_count) + 1);
  assert.equal(row.resolved_at, null);
  assert.match(String(row.last_error || ""), /ingest_failed/i);
  assert.ok(new Date(row.next_retry_at).getTime() > Date.now());
});
