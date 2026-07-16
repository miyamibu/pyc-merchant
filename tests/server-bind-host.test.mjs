import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { readFileSync } from "node:fs";

import { baseServerEnv, startServerProcess, stopServerProcess } from "./helpers/server-process.mjs";

function canConnect(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: Number(port) });
    let settled = false;
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

test("APP_BIND_HOST can restrict a local development server to 127.0.0.1", async () => {
  const env = baseServerEnv({ APP_BIND_HOST: "127.0.0.1" });
  const started = await startServerProcess(process.cwd(), env);
  try {
    const { port } = new URL(started.baseUrl);
    assert.equal(await canConnect("127.0.0.1", port), true);
    assert.equal(await canConnect("127.0.0.2", port), false);
    assert.match(started.logs.join(""), /Bind host: 127\.0\.0\.1/);
  } finally {
    await stopServerProcess(started.proc);
  }
});

test("HTTP logs redact fixed-entry and signed-payment URL secrets", async () => {
  const env = baseServerEnv({ APP_BIND_HOST: "127.0.0.1" });
  const started = await startServerProcess(process.cwd(), env);
  const secrets = {
    fixedEntry: "fixed-entry-secret-value",
    signedRef: "signed-ref-secret-value",
    signature: "signature-secret-value",
    nonce: "nonce-secret-value",
  };
  try {
    const requests = [
      `/t/${secrets.fixedEntry}`,
      `/api/v1/public/terminal-entry/${secrets.fixedEntry}`,
      `/pay?ref=${secrets.signedRef}`,
      `/mobile.html?invoiceId=invoice-visible&sig=${secrets.signature}&nonce=${secrets.nonce}&exp=9999999999`,
    ];
    for (const pathName of requests) {
      await fetch(`${started.baseUrl}${pathName}`, { redirect: "manual" });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const logs = started.logs.join("");
    for (const secret of Object.values(secrets)) assert.doesNotMatch(logs, new RegExp(secret));
    assert.match(logs, /\/t\/\[REDACTED\]/);
    assert.match(logs, /\/api\/v1\/public\/terminal-entry\/\[REDACTED\]/);
    assert.match(logs, /ref=%5BREDACTED%5D/);
    assert.match(logs, /sig=%5BREDACTED%5D/);
    assert.match(logs, /nonce=%5BREDACTED%5D/);

    const source = readFileSync(new URL("../src/server.mjs", import.meta.url), "utf8");
    assert.match(source, /type: "http\.error"[\s\S]*?path: redactUrlForLogs\(req\.originalUrl \|\| req\.path\)/);
  } finally {
    await stopServerProcess(started.proc);
  }
});
