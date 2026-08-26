import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import Database from "better-sqlite3";

const WATCHER = path.resolve("deploy/launchd/targets/health-watch.mjs");

function runWatcher(env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [WATCHER],
      {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        encoding: "utf8",
        timeout: 20_000,
      },
      (error, stdout, stderr) => {
        resolve({
          code: Number.isInteger(error?.code) ? error.code : 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      }
    );
  });
}

function createWorkerState(dbPath, { lastCycleAt = new Date().toISOString(), rpcCount = "2", checkpoint = "12345" } = {}) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE chain_monitor_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  const insert = db.prepare(`INSERT INTO chain_monitor_state (key, value, updated_at) VALUES (?, ?, ?)`);
  const updatedAt = new Date().toISOString();
  insert.run("worker:137:last_cycle_at", lastCycleAt, updatedAt);
  insert.run("worker:137:rpc_count", rpcCount, updatedAt);
  insert.run("worker:137:last_checkpoint", checkpoint, updatedAt);
  db.close();
}

async function withHealthServer(callback) {
  const server = http.createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await callback(address.port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("health watcher fails closed when worker state configuration is missing", async () => {
  const result = await runWatcher({ APP_BIND_HOST: "127.0.0.1", APP_PORT: "4173", WORKER_STATE_DB_PATH: "" });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /"reason":"worker_state_db_path_required"/);
  assert.equal(result.stderr, "");
});

test("health watcher accepts loopback health and a fresh read-only worker checkpoint", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jpyc-health-watch-"));
  try {
    const workerDb = path.join(tempRoot, "worker.sqlite3");
    createWorkerState(workerDb);
    await withHealthServer(async (port) => {
      const result = await runWatcher({
        APP_BIND_HOST: "127.0.0.1",
        APP_PORT: String(port),
        CHAIN_ID: "137",
        WORKER_STALE_SEC: "180",
        WORKER_STATE_DB_PATH: workerDb,
      });
      assert.equal(result.code, 0, result.stdout || result.stderr);
      assert.match(result.stdout, /"code":"healthy"/);
      assert.equal(result.stderr, "");
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("health watcher rejects stale worker state even while healthz is green", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jpyc-health-watch-stale-"));
  try {
    const workerDb = path.join(tempRoot, "worker.sqlite3");
    createWorkerState(workerDb, { lastCycleAt: new Date(Date.now() - 600_000).toISOString() });
    await withHealthServer(async (port) => {
      const result = await runWatcher({
        APP_BIND_HOST: "127.0.0.1",
        APP_PORT: String(port),
        CHAIN_ID: "137",
        WORKER_STALE_SEC: "180",
        WORKER_STATE_DB_PATH: workerDb,
      });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /"reason":"worker_state_stale"/);
      assert.equal(result.stderr, "");
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
