#!/usr/bin/env node
// launchd target: fail-closed loopback health watcher for the
// local_store_terminal topology.
//
// Scope (deliberately small):
//   1. GET http://<loopback>:<port>/healthz and require HTTP 200 with JSON
//      body { ok: true }.
//   2. Open WORKER_STATE_DB_PATH read-only and require fresh worker state,
//      mirroring the app's own worker-freshness semantics:
//        - worker:<CHAIN_ID>:last_cycle_at present, parseable, not in the
//          future beyond a small clock-skew tolerance, and younger than
//          WORKER_STALE_SEC seconds;
//        - worker:<CHAIN_ID>:rpc_count >= 1;
//        - worker:<CHAIN_ID>:last_checkpoint present.
//
// Guarantees:
// - Fails closed: any missing config, unreadable state DB, timeout, non-200
//   response, or stale worker exits non-zero so launchd records the failure.
// - Read-only: never writes to the worker/app databases.
// - Output is one structured JSON line per run; env values are never printed.
// - This watcher does NOT deliver alerts anywhere. Its only signals are its
//   stdout/stderr logs (captured by launchd) and its exit code. External alert
//   delivery must not be claimed from this script.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import process from "node:process";
import Database from "better-sqlite3";
import { resolveListenerPort } from "../../../src/deployment-topology.mjs";

const HTTP_TIMEOUT_MS = 5000;
const OVERALL_TIMEOUT_MS = 15000;
const CLOCK_FUTURE_TOLERANCE_MS = 30_000; // mirrors SERVICE_AUTH_MAX_FUTURE_SEC default
const MAX_BODY_BYTES = 64 * 1024;

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function fail(reason, extra = {}) {
  emit({ ok: false, code: "unhealthy", reason, ...extra });
  process.exit(1);
}

function positiveIntFromEnv(name, fallback) {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

const overallTimer = setTimeout(() => fail("watchdog_timeout"), OVERALL_TIMEOUT_MS);

const bindHostRaw = String(process.env.APP_BIND_HOST ?? "").trim() || "127.0.0.1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
if (!LOOPBACK_HOSTS.has(bindHostRaw)) fail("bind_host_not_loopback", { bind_host_class: "rejected" });

const port = resolveListenerPort(process.env);
if (!Number.isInteger(port) || port < 1 || port > 65535) fail("app_port_invalid");

const chainId = positiveIntFromEnv("CHAIN_ID", 137);
if (chainId === null) fail("chain_id_invalid");

const workerStaleSec = positiveIntFromEnv("WORKER_STALE_SEC", 180);
if (workerStaleSec === null) fail("worker_stale_sec_invalid");

const workerStateDbPath = String(process.env.WORKER_STATE_DB_PATH ?? "").trim();
if (!workerStateDbPath) fail("worker_state_db_path_required");

function checkHttpHealth() {
  return new Promise((resolve) => {
    const options = {
      host: bindHostRaw,
      port,
      path: "/healthz",
      method: "GET",
      headers: { accept: "application/json" },
      timeout: HTTP_TIMEOUT_MS,
    };
    const request = http.get(options, (response) => {
      const chunks = [];
      let totalBytes = 0;
      let settled = false;
      const finish = (healthy, reason) => {
        if (settled) return;
        settled = true;
        response.resume();
        resolve({ healthy, reason });
      };
      response.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) finish(false, "healthz_body_too_large");
        else chunks.push(chunk);
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          finish(false, "healthz_not_ok_status");
          return;
        }
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          finish(body?.ok === true ? true : false, body?.ok === true ? null : "healthz_body_not_ok");
        } catch {
          finish(false, "healthz_body_not_json");
        }
      });
      response.on("error", () => finish(false, "healthz_response_error"));
      response.on("aborted", () => finish(false, "healthz_aborted"));
    });
    request.on("timeout", () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", () => resolve({ healthy: false, reason: "healthz_request_failed" }));
  });
}

function checkWorkerFreshness() {
  const resolvedPath = path.resolve(workerStateDbPath);
  let db;
  try {
    fs.accessSync(resolvedPath);
    db = new Database(resolvedPath, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 5000");
    db.pragma("query_only = ON");
  } catch {
    return { healthy: false, reason: "worker_state_db_unreadable" };
  }
  try {
    const stateGet = (key) => {
      try {
        return db.prepare(`SELECT value FROM chain_monitor_state WHERE key = ?`).get(key) || null;
      } catch (error) {
        if (String(error.message || error).includes("no such table")) return "NO_TABLE";
        throw error;
      }
    };
    const lastCycle = stateGet(`worker:${chainId}:last_cycle_at`);
    const rpcCount = stateGet(`worker:${chainId}:rpc_count`);
    const checkpoint = stateGet(`worker:${chainId}:last_checkpoint`);
    if (lastCycle === "NO_TABLE" || rpcCount === "NO_TABLE" || checkpoint === "NO_TABLE") {
      return { healthy: false, reason: "worker_state_missing_table" };
    }
    const lastCycleAtMs = lastCycle?.value ? new Date(lastCycle.value).getTime() : NaN;
    if (!Number.isFinite(lastCycleAtMs)) return { healthy: false, reason: "worker_last_cycle_missing" };
    const nowMs = Date.now();
    if (lastCycleAtMs > nowMs + CLOCK_FUTURE_TOLERANCE_MS) {
      return { healthy: false, reason: "worker_clock_skew" };
    }
    if (nowMs - lastCycleAtMs > workerStaleSec * 1000) {
      return { healthy: false, reason: "worker_state_stale", age_sec: Math.floor((nowMs - lastCycleAtMs) / 1000) };
    }
    if (!Number.isFinite(Number(rpcCount?.value)) || Number(rpcCount.value) < 1) {
      return { healthy: false, reason: "worker_rpc_count_missing" };
    }
    if (!checkpoint?.value) return { healthy: false, reason: "worker_checkpoint_missing" };
    return { healthy: true, reason: null };
  } catch {
    return { healthy: false, reason: "worker_state_query_failed" };
  } finally {
    try {
      db.close();
    } catch {
      // no-op
    }
  }
}

const [httpResult, workerResult] = await Promise.all([checkHttpHealth(), checkWorkerFreshness()]);
clearTimeout(overallTimer);
if (!httpResult.healthy) fail(httpResult.reason);
if (!workerResult.healthy) fail(workerResult.reason, workerResult.age_sec !== undefined ? { age_sec: workerResult.age_sec } : {});
emit({ ok: true, code: "healthy", chain_id: chainId, port });
process.exit(0);
