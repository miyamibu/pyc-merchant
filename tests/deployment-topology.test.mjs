import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  createInvoice,
  getInvoice,
  loginAs,
  productionServerEnv,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";
import {
  DEPLOYMENT_TOPOLOGY_VALUES,
  evaluateLocalStoreTerminalTopology,
  isLoopbackHost,
  parseDeploymentTopology,
  resolvePublicPolicyOrigin,
} from "../src/deployment-topology.mjs";
import { hashPolicyContent, POLICY_DOCUMENT_CONTRACT } from "../src/policy-publication.mjs";
import { renderPolicyDocument } from "../sites/jpyc-public-info/app/policy-document.mjs";

const CWD = process.cwd();
const PUBLIC_POLICY_ORIGIN = "https://miyamibu.xyz";
const OFFICIAL_JPYC_TOKEN = "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29";
const LOCAL_POLICY_CONTENTS = {
  terms: JSON.stringify({ title: "Local terminal terms", summary: "Version: 2026-08-26", sections: [{ title: "Terms", paragraphs: ["Pay only from the terminal QR."] }] }),
  privacy: JSON.stringify({ title: "Local terminal privacy", summary: "Version: 2026-08-26", sections: [{ title: "Privacy", paragraphs: ["No wallet secrets are collected."] }] }),
  refund: JSON.stringify({ title: "Local terminal refund policy", summary: "Version: 2026-08-26", sections: [{ title: "Refund", bullets: ["Refunds require review."] }] }),
};

function policySiteFixture(contents = LOCAL_POLICY_CONTENTS) {
  const dir = mkdtempSync(path.join(tmpdir(), "jpyc-policy-site-fixture-"));
  const file = path.join(dir, "pages.json");
  const write = (value) => writeFileSync(file, JSON.stringify(value));
  write(contents);
  return { file, write, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function spawnForExit(env) {
  const logs = [];
  const proc = spawn(process.execPath, ["src/server.mjs"], {
    cwd: CWD,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (chunk) => logs.push(String(chunk)));
  proc.stderr.on("data", (chunk) => logs.push(String(chunk)));
  return { proc, logs };
}

function waitForExit(proc, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("server did not exit"));
    }, timeoutMs);
    proc.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test("deployment topology parsing accepts only documented values", () => {
  assert.deepEqual([...DEPLOYMENT_TOPOLOGY_VALUES], ["public_cloud", "local_store_terminal"]);
  assert.equal(parseDeploymentTopology(""), "public_cloud");
  assert.equal(parseDeploymentTopology(null), "public_cloud");
  assert.equal(parseDeploymentTopology(" PUBLIC_CLOUD "), "public_cloud");
  assert.equal(parseDeploymentTopology("local_store_terminal"), "local_store_terminal");
  assert.equal(parseDeploymentTopology("hybrid"), null);
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("192.168.1.10"), false);
});

test("local store terminal structural evaluation fails closed on every missing input", () => {
  const base = {
    APP_BIND_HOST: "127.0.0.1",
    PUBLIC_POLICY_ORIGIN: PUBLIC_POLICY_ORIGIN,
    APP_HOST: "http://127.0.0.1:4173",
    PAY_BASE_URL: "http://127.0.0.1:4173",
    INTERNAL_APP_ORIGIN: "http://127.0.0.1:4173",
    CORS_ALLOW_ORIGINS: "http://127.0.0.1:4173",
    TRUST_PROXY: "false",
    PUBLIC_PAYMENT_PAGE_ENABLED: "false",
    WALLET_ADAPTER_TYPE: "wallet_deeplink",
    RECIPIENT_ADDRESS: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    CHAIN_ID: "137",
    ENABLED_PAYMENT_CHAIN_IDS: "137",
    RPC_URLS_137: "https://polygon-rpc.example.com",
    BACKUP_DIR: "./runtime/backups",
    WORKER_STATE_DB_PATH: "./runtime/worker-state/chain-137.db",
    LOCAL_TERMINAL_OPERATOR_READINESS_REF: "MAC-READY-2026-08",
  };
  const ok = evaluateLocalStoreTerminalTopology(base);
  assert.equal(ok.ok, true, JSON.stringify(ok.blockers));
  assert.deepEqual(ok.blockers, []);

  // The official policy origin key wins over the compatible fallback.
  const officialKeyResult = evaluateLocalStoreTerminalTopology({
    ...base,
    PUBLIC_POLICY_ORIGIN: "",
    PUBLIC_BASE_URL: PUBLIC_POLICY_ORIGIN,
  });
  assert.equal(officialKeyResult.ok, true, JSON.stringify(officialKeyResult.blockers));
  assert.equal(
    resolvePublicPolicyOrigin({ PUBLIC_POLICY_ORIGIN: `${PUBLIC_POLICY_ORIGIN}/` })?.origin,
    PUBLIC_POLICY_ORIGIN
  );
  const invalidOfficialKey = evaluateLocalStoreTerminalTopology({
    ...base,
    PUBLIC_POLICY_ORIGIN: "ftp://bad.example",
    PUBLIC_BASE_URL: PUBLIC_POLICY_ORIGIN,
  });
  assert.equal(invalidOfficialKey.ok, false);
  assert.ok(invalidOfficialKey.blockers.includes("topology_local_requires_public_policy_origin"));

  const cases = [
    [{ ...base, APP_BIND_HOST: "0.0.0.0" }, "topology_local_requires_loopback_bind_host"],
    [{ ...base, PUBLIC_POLICY_ORIGIN: "", PUBLIC_BASE_URL: "http://127.0.0.1:8080" }, "topology_local_requires_public_policy_origin"],
    [{ ...base, PUBLIC_POLICY_ORIGIN: "" }, "topology_local_requires_public_policy_origin"],
    [{ ...base, PUBLIC_PAYMENT_PAGE_ENABLED: "" }, "topology_local_requires_public_payment_page_disabled"],
    [{ ...base, PUBLIC_PAYMENT_PAGE_ENABLED: "true" }, "topology_local_requires_public_payment_page_disabled"],
    [{ ...base, PUBLIC_PAYMENT_PAGE_ENABLED: "0" }, "topology_local_requires_public_payment_page_disabled"],
    [{ ...base, PUBLIC_PAYMENT_PAGE_ENABLED: "off" }, "topology_local_requires_public_payment_page_disabled"],
    [{ ...base, PUBLIC_BASE_URL: "https://other.example" }, "topology_local_public_base_url_policy_origin_mismatch"],
    [{ ...base, APP_HOST: "https://pay.miyamibu.xyz" }, "topology_local_app_host_must_be_loopback_http_origin"],
    [{ ...base, APP_HOST: "" }, "topology_local_requires_explicit_app_host"],
    [{ ...base, PAY_BASE_URL: "" }, "topology_local_requires_explicit_pay_base_url"],
    [{ ...base, TRUST_PROXY: "true" }, "topology_local_requires_direct_loopback_no_trusted_proxy"],
    [{ ...base, ENABLE_PUBLIC_PAYMENT_SIMULATION: "true" }, "topology_local_requires_enable_public_payment_simulation_disabled"],
    [{ ...base, DEMO_CONTROLS_ENABLED: "true" }, "topology_local_requires_demo_controls_disabled"],
    [{ ...base, ALLOW_MANUAL_PAYMENT_INGEST: "true" }, "topology_local_requires_manual_payment_ingest_disabled"],
    [{ ...base, ENABLE_PROVIDER_RAIL_MOCK: "true" }, "topology_local_requires_provider_rail_mock_disabled"],
    [{ ...base, DIAGNOSTIC_MODE_ENABLED: "true" }, "topology_local_requires_diagnostic_mode_disabled"],
    [{ ...base, WALLET_ADAPTER_TYPE: "mock" }, "topology_local_requires_reviewed_wallet_deeplink_adapter"],
    [{ ...base, RECIPIENT_ADDRESS: "" }, "topology_local_requires_configured_recipient_address"],
    [{ ...base, CHAIN_ID: "1" }, "topology_local_requires_chain_137"],
    [{ ...base, ENABLED_PAYMENT_CHAIN_IDS: "137,1" }, "topology_local_requires_single_chain_137_enabled"],
    [{ ...base, RPC_URLS_137: "", RPC_URLS: "" }, "topology_local_requires_chain_rpc_endpoints"],
    [{ ...base, BACKUP_DIR: "" }, "topology_local_requires_backup_dir"],
    [{ ...base, WORKER_STATE_DB_PATH: "" }, "topology_local_requires_worker_state_db_path"],
    [{ ...base, LOCAL_TERMINAL_OPERATOR_READINESS_REF: "" }, "topology_local_requires_mac_readiness_reference"],
  ];
  for (const [env, expectedBlocker] of cases) {
    const result = evaluateLocalStoreTerminalTopology(env);
    assert.equal(result.ok, false, `expected failure for ${expectedBlocker}`);
    assert.ok(result.blockers.includes(expectedBlocker), `${expectedBlocker} missing in ${JSON.stringify(result.blockers)}`);
  }
});

test("unknown DEPLOYMENT_TOPOLOGY values are rejected before startup", async () => {
  const env = baseServerEnv({ DEPLOYMENT_TOPOLOGY: "event_booth" });
  const started = spawnForExit(env);
  const exit = await waitForExit(started.proc);
  assert.notEqual(exit.code, 0);
  assert.match(started.logs.join(""), /DEPLOYMENT_TOPOLOGY must be public_cloud or local_store_terminal/i);
});

test("local_store_terminal rejects a non-loopback app origin even in production-like runtime", async () => {
  const env = productionServerEnv({
    APP_ENV: "development",
    COMMERCIAL_GO_MODE: "false",
    DEPLOYMENT_STAGE: "pilot",
    DEPLOYMENT_TOPOLOGY: "local_store_terminal",
    TRUST_PROXY: "false",
    TRUST_PROXY_HOPS: "",
    BACKUP_DIR: "./runtime/backups",
    LOCAL_TERMINAL_OPERATOR_READINESS_REF: "MAC-READY-2026-08",
    RPC_URLS_137: "https://polygon-rpc.example.com",
  });
  // The public payment origin must never become the loopback app origin.
  env.APP_HOST = PUBLIC_POLICY_ORIGIN;
  env.PAY_BASE_URL = PUBLIC_POLICY_ORIGIN;
  const started = spawnForExit(env);
  const exit = await waitForExit(started.proc);
  assert.notEqual(exit.code, 0);
  assert.match(started.logs.join(""), /loopback http:\/\/127\.0\.0\.1 origin/i);
});

test("local_store_terminal requires the Mac operational readiness reference", async () => {
  const port = 21000 + ((process.pid * 37) % 20000);
  const env = productionServerEnv({
    APP_ENV: "development",
    COMMERCIAL_GO_MODE: "false",
    DEPLOYMENT_STAGE: "pilot",
    DEPLOYMENT_TOPOLOGY: "local_store_terminal",
    APP_PORT: String(port),
    APP_HOST: `http://127.0.0.1:${port}`,
    PAY_BASE_URL: `http://127.0.0.1:${port}`,
    CORS_ALLOW_ORIGINS: `http://127.0.0.1:${port}`,
    PUBLIC_BASE_URL: PUBLIC_POLICY_ORIGIN,
    TRUST_PROXY: "false",
    TRUST_PROXY_HOPS: "",
    BACKUP_DIR: "./runtime/backups",
    LOCAL_TERMINAL_OPERATOR_READINESS_REF: "",
    RPC_URLS_137: "https://polygon-rpc.example.com",
  });
  const started = spawnForExit(env);
  const exit = await waitForExit(started.proc);
  assert.notEqual(exit.code, 0);
  assert.match(started.logs.join(""), /topology_local_requires_mac_readiness_reference/);
});

test("local_store_terminal serves on loopback, disables public payment pages, gates the transfer QR behind staff-recorded policy consent, and emits an exact wallet transfer QR", async (t) => {
  const siteFixture = policySiteFixture();
  const port = 21000 + ((process.pid * 53 + 7) % 20000);
  const env = productionServerEnv({
    NODE_OPTIONS: "--import=./tests/helpers/mock-policy-site.mjs",
    POLICY_SITE_FIXTURE_PATH: siteFixture.file,
    APP_ENV: "development",
    COMMERCIAL_GO_MODE: "false",
    DEPLOYMENT_STAGE: "development",
    DEPLOYMENT_TOPOLOGY: "local_store_terminal",
    APP_PORT: String(port),
    APP_HOST: `http://127.0.0.1:${port}`,
    PAY_BASE_URL: `http://127.0.0.1:${port}`,
    CORS_ALLOW_ORIGINS: `http://127.0.0.1:${port}`,
    PUBLIC_POLICY_ORIGIN: PUBLIC_POLICY_ORIGIN,
    PUBLIC_BASE_URL: PUBLIC_POLICY_ORIGIN,
    TRUST_PROXY: "false",
    TRUST_PROXY_HOPS: "",
    PUBLIC_PAYMENT_PAGE_ENABLED: "false",
    BACKUP_DIR: "./runtime/backups",
    LOCAL_TERMINAL_OPERATOR_READINESS_REF: "MAC-READY-2026-08",
    RPC_URLS_137: "https://polygon-rpc.example.com",
    // Dev-runtime fixture control so the configured approved recipient is used
    // for the invoice QR. Production runtimes allocate controlled pool
    // addresses instead (see tests/address-pool-sse.test.mjs).
    RECEIVE_ADDRESS_DEV_AUTO_VERIFY: "true",
  });

  const started = await startServerProcess(CWD, env);
  t.after(async () => { await stopServerProcess(started.proc); siteFixture.cleanup(); });
  assert.match(started.logs.join(""), /Deployment topology: local_store_terminal/);

  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });
  assert.equal(admin.deploymentTopology, "local_store_terminal");
  // The official policy origin key is exposed for Sites links / guide QR.
  assert.equal(resolvePublicPolicyOrigin({ PUBLIC_POLICY_ORIGIN: PUBLIC_POLICY_ORIGIN })?.source, "PUBLIC_POLICY_ORIGIN");

  // Publish the store's Sites policy snapshot before issuance so the invoice
  // carries a ready consent target (urls + versions + sha256 hashes).
  const policyContents = LOCAL_POLICY_CONTENTS;
  const policyVersions = {
    terms_version: "2026-08-26",
    privacy_version: "2026-08-26",
    refund_policy_version: "2026-08-26",
  };
  const policyPublish = await apiRequest(
    started.baseUrl,
    `/api/v1/admin/stores/${encodeURIComponent(admin.storeId)}/customer-policies`,
    {
      method: "PATCH",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `local-policy-${Date.now()}`,
      }),
      body: JSON.stringify({
        terms_url: `${PUBLIC_POLICY_ORIGIN}/terms`,
        privacy_url: `${PUBLIC_POLICY_ORIGIN}/privacy`,
        refund_policy_url: `${PUBLIC_POLICY_ORIGIN}/refund-policy`,
        ...policyVersions,
        terms_hash: hashPolicyContent(policyContents.terms),
        privacy_hash: hashPolicyContent(policyContents.privacy),
        refund_policy_hash: hashPolicyContent(policyContents.refund),
        contents: policyContents,
      }),
    }
  );
  assert.equal(policyPublish.status, 200, JSON.stringify(policyPublish.data));

  const amountJpy = 1880;
  const created = await createInvoice(started.baseUrl, admin.token, amountJpy, `local-topology-${Date.now()}`);
  assert.equal(created.status, 201, `${JSON.stringify(created.data)}\n${started.logs.join("")}`);

  // No public signed payment URL may leave the terminal boundary.
  assert.ok(!created.data.payment_url, "payment_url must be absent in local_store_terminal");
  assert.ok(!created.data.pay_url, "pay_url must be absent/null in local_store_terminal");
  assert.equal(created.data.fixed_qr_url, null, "fixed public entry QR must be absent in local_store_terminal");
  assert.equal(created.data.terminal_public_entry_token, null);

  // Fail closed: no transfer URI leaves the server before the per-invoice
  // policy consent is recorded from this authenticated staff session.
  assert.ok(!created.data.payment_uri, "payment_uri must be withheld until policy consent is recorded");
  assert.ok(!created.data.qr_payload, "qr_payload must be withheld until policy consent is recorded");
  assert.ok(!created.data.wallet_url, "wallet_url must be withheld until policy consent is recorded");
  assert.equal(created.data.customer_policy_consent?.required, true);
  assert.equal(created.data.customer_policy_consent?.recorded, false);
  assert.equal(created.data.customer_policy_consent?.ready, true);

  const relogin = await apiRequest(started.baseUrl, "/api/v1/terminal-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      terminalCode: env.TERMINAL_CODE,
      staffPin: env.STAFF_PIN,
      staffName: "Demo Staff",
    }),
  });
  assert.ok([200, 201].includes(relogin.status), JSON.stringify(relogin.data));
  assert.equal(relogin.data.current_invoice?.payment_url, null);
  assert.equal(relogin.data.current_invoice?.customer_policy_consent?.recorded, false);
  assert.equal(relogin.data.fixed_qr_url, null);
  assert.equal(relogin.data.public_entry_token, null);

  const invoiceId = created.data.invoice_id;

  // The staff-recorded consent endpoint rejects wrong versions and any extra
  // (PII-bearing) keys without creating a record.
  const mismatch = await apiRequest(
    started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(invoiceId)}/policy-consent`,
    {
      method: "POST",
      headers: authHeaders(admin.token, { "content-type": "application/json" }),
      body: JSON.stringify({
        terms_version: "wrong-v1",
        privacy_version: created.data.customer_policy_consent.versions.privacy_version,
        refund_policy_version: created.data.customer_policy_consent.versions.refund_policy_version,
      }),
    }
  );
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.data.error?.code, "POLICY_VERSION_MISMATCH");

  const piiAttempt = await apiRequest(
    started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(invoiceId)}/policy-consent`,
    {
      method: "POST",
      headers: authHeaders(admin.token, { "content-type": "application/json" }),
      body: JSON.stringify({
        terms_version: created.data.customer_policy_consent.versions.terms_version,
        privacy_version: created.data.customer_policy_consent.versions.privacy_version,
        refund_policy_version: created.data.customer_policy_consent.versions.refund_policy_version,
        customer_email: "nope@example.com",
      }),
    }
  );
  assert.equal(piiAttempt.status, 409);
  assert.deepEqual(piiAttempt.data.error?.details?.unexpected_keys, ["customer_email"]);

  const unauthenticatedConsent = await apiRequest(
    started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(invoiceId)}/policy-consent`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(created.data.customer_policy_consent.versions),
    }
  );
  assert.equal(unauthenticatedConsent.status, 401);

  // A correct stored body/hash is insufficient when one served page differs.
  // Keep the old marker while changing the text rendered inside the page.
  const changedTerms = JSON.parse(policyContents.terms);
  changedTerms.sections[0].paragraphs[0] = "Different published terms";
  siteFixture.write({ ...policyContents, terms: JSON.stringify(changedTerms), $markerOverrides: { terms: hashPolicyContent(policyContents.terms) } });
  const wrongSite = await apiRequest(
    started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(invoiceId)}/policy-consent`,
    {
      method: "POST",
      headers: authHeaders(admin.token, { "content-type": "application/json" }),
      body: JSON.stringify(policyVersions),
    }
  );
  assert.equal(wrongSite.status, 503, JSON.stringify(wrongSite.data));
  assert.equal(wrongSite.data.error?.code, "POLICY_SITE_CONTENT_UNVERIFIED");
  assert.deepEqual(wrongSite.data.error?.details?.unavailable_keys, ["terms"]);
  const mismatchDb = new Database(env.DB_PATH, { readonly: true, fileMustExist: true });
  assert.equal(mismatchDb.prepare(`SELECT COUNT(*) AS count FROM invoice_consents WHERE invoice_id = ?`).get(invoiceId).count, 0);
  mismatchDb.close();
  // Independent review's counterexamples must never insert a consent row.
  const baselineDoc = renderPolicyDocument(policyContents.terms);
  for (const changedDoc of [
    baselineDoc.replace('</p></header>', '</p><p class="new-policy">A large fee applies.</p></header>'),
    baselineDoc.replace('</article></main>', '</article><section><h2>New fees</h2><p>A large fee applies.</p></section></main>'),
    baselineDoc.replace('<main id="main">', '<main id="main" hidden>') + '<main id="main"><p>Different terms</p></main>',
  ]) {
    siteFixture.write({ ...policyContents, $htmlOverrides: { terms: changedDoc } });
    const denied = await apiRequest(started.baseUrl, `/api/v1/invoices/${encodeURIComponent(invoiceId)}/policy-consent`, {
      method: "POST", headers: authHeaders(admin.token, { "content-type": "application/json" }),
      body: JSON.stringify(policyVersions),
    });
    assert.equal(denied.status, 503, JSON.stringify(denied.data));
    const evidenceDb = new Database(env.DB_PATH, { readonly: true, fileMustExist: true });
    assert.equal(evidenceDb.prepare(`SELECT COUNT(*) AS count FROM invoice_consents WHERE invoice_id = ?`).get(invoiceId).count, 0);
    evidenceDb.close();
  }
  siteFixture.write(policyContents);

  const recorded = await apiRequest(
    started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(invoiceId)}/policy-consent`,
    {
      method: "POST",
      headers: authHeaders(admin.token, { "content-type": "application/json" }),
      body: JSON.stringify(created.data.customer_policy_consent.versions),
    }
  );
  assert.equal(recorded.status, 201, JSON.stringify(recorded.data));
  assert.equal(recorded.data.ok, true);
  assert.ok(recorded.data.recorded_at);

  // Idempotent replay returns the original record.
  const replay = await apiRequest(
    started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(invoiceId)}/policy-consent`,
    {
      method: "POST",
      headers: authHeaders(admin.token, { "content-type": "application/json" }),
      body: JSON.stringify(created.data.customer_policy_consent.versions),
    }
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.data.idempotent_replay, true);
  assert.equal(replay.data.consent_id, recorded.data.consent_id);

  // After consent succeeds, the invoice payload exposes the exact EIP-681
  // wallet transfer URI for this invoice.
  const afterConsent = await getInvoice(started.baseUrl, admin.token, invoiceId);
  assert.equal(afterConsent.status, 200, JSON.stringify(afterConsent.data));
  assert.equal(afterConsent.data.customer_policy_consent?.recorded, true);
  const expectedAtomic = `${amountJpy}` + "0".repeat(18);
  const configuredRecipient = String(env.RECIPIENT_ADDRESS).toLowerCase();
  const expectedUri = `ethereum:${OFFICIAL_JPYC_TOKEN.toLowerCase()}@137/transfer?address=${configuredRecipient}&uint256=${expectedAtomic}`;
  assert.equal(afterConsent.data.payment_uri, expectedUri);
  assert.equal(afterConsent.data.amounts?.token_amount_atomic, expectedAtomic);
  assert.equal(afterConsent.data.chain?.chain_id, "137");
  assert.equal(afterConsent.data.chain?.recipient_address, configuredRecipient);

  // Persisted consent must not reactivate any non-issued or elapsed invoice.
  const lifecycleDb = new Database(env.DB_PATH);
  const originalExpiry = lifecycleDb.prepare(`SELECT expires_at FROM invoices WHERE id = ?`).get(invoiceId).expires_at;
  const verifiedAt = lifecycleDb.prepare(`SELECT site_content_verified_at FROM invoice_consents WHERE invoice_id = ?`).get(invoiceId).site_content_verified_at;
  assert.ok(verifiedAt);
  assert.equal(lifecycleDb.prepare(`SELECT site_content_contract FROM invoice_consents WHERE invoice_id = ?`).get(invoiceId).site_content_contract, POLICY_DOCUMENT_CONTRACT);
  try {
    for (const status of ["payment_detected", "confirming", "paid", "settled", "refunded", "review_required", "expired", "cancelled", "unknown_future_status"]) {
      lifecycleDb.prepare(`UPDATE invoices SET status = ? WHERE id = ?`).run(status, invoiceId);
      const closed = await getInvoice(started.baseUrl, admin.token, invoiceId);
      assert.equal(closed.status, 200);
      assert.equal(closed.data.payment_uri, null, status);
      assert.equal(closed.data.wallet_url, null, status);
      assert.equal(closed.data.wallet_deeplink, null, status);
      for (const field of ["chain_id", "token_contract", "receive_address", "expected_amount_atomic", "copy_fallback"]) {
        assert.equal(closed.data[field], null, `${status}:${field}`);
      }
      assert.deepEqual(closed.data.chain, { chain_id: null, token_contract: null, recipient_address: null });
      assert.equal(closed.data.amounts.token_amount_atomic, null);
      assert.equal(closed.data.diagnostics?.payment_uri || null, null, status);
    }
    lifecycleDb.prepare(`UPDATE invoices SET status = 'issued', expires_at = ? WHERE id = ?`).run("2020-01-01T00:00:00.000Z", invoiceId);
    const elapsed = await getInvoice(started.baseUrl, admin.token, invoiceId);
    assert.equal(elapsed.data.payment_uri, null);
    lifecycleDb.prepare(`UPDATE invoices SET expires_at = ? WHERE id = ?`).run("invalid-expiry", invoiceId);
    const malformedExpiry = await getInvoice(started.baseUrl, admin.token, invoiceId);
    assert.equal(malformedExpiry.data.payment_uri, null);

    lifecycleDb.prepare(`UPDATE invoices SET expires_at = ? WHERE id = ?`).run(originalExpiry, invoiceId);
    // Earlier candidate rows with a timestamp but no v2 contract are legacy too.
    lifecycleDb.prepare(`UPDATE invoice_consents SET site_content_contract = NULL WHERE invoice_id = ?`).run(invoiceId);
    const previousCandidate = await getInvoice(started.baseUrl, admin.token, invoiceId);
    assert.equal(previousCandidate.data.payment_uri, null);
    assert.equal(previousCandidate.data.customer_policy_consent?.requires_reissue, true);
    lifecycleDb.prepare(`UPDATE invoice_consents SET site_content_contract = ? WHERE invoice_id = ?`).run(POLICY_DOCUMENT_CONTRACT, invoiceId);
    lifecycleDb.prepare(`UPDATE invoice_consents SET site_content_verified_at = NULL WHERE invoice_id = ?`).run(invoiceId);
    const legacy = await getInvoice(started.baseUrl, admin.token, invoiceId);
    assert.equal(legacy.data.payment_uri, null);
    assert.equal(legacy.data.customer_policy_consent?.recorded, false);
    assert.equal(legacy.data.customer_policy_consent?.requires_reissue, true);
    const legacyReplay = await apiRequest(started.baseUrl, `/api/v1/invoices/${encodeURIComponent(invoiceId)}/policy-consent`, {
      method: "POST",
      headers: authHeaders(admin.token, { "content-type": "application/json" }),
      body: JSON.stringify(policyVersions),
    });
    assert.equal(legacyReplay.status, 409);
    assert.equal(legacyReplay.data.error?.code, "POLICY_CONSENT_REISSUE_REQUIRED");
  } finally {
    lifecycleDb.prepare(`UPDATE invoices SET status = 'issued', expires_at = ? WHERE id = ?`).run(originalExpiry, invoiceId);
    lifecycleDb.prepare(`UPDATE invoice_consents SET site_content_verified_at = ? WHERE invoice_id = ?`).run(verifiedAt, invoiceId);
    lifecycleDb.prepare(`UPDATE invoice_consents SET site_content_contract = ? WHERE invoice_id = ?`).run(POLICY_DOCUMENT_CONTRACT, invoiceId);
    lifecycleDb.close();
  }

  // Customer web payment entry points stay disabled by topology.
  const blockedPaths = [
    `/pay?ref=${encodeURIComponent("anything")}`,
    `/t/${encodeURIComponent(admin.publicEntryToken || "missing")}`,
    "/api/v1/public/terminal-entry/missing",
    "/mobile.html?invoiceId=x&sig=y&nonce=z&exp=1",
  ];
  for (const pathName of blockedPaths) {
    const res = await fetch(`${started.baseUrl}${pathName}`, { redirect: "manual" });
    assert.equal(res.status, 404, `${pathName} must be disabled`);
    const payload = await res.json().catch(() => ({}));
    assert.equal(payload.error?.code, "PUBLIC_CUSTOMER_PAYMENT_DISABLED_BY_TOPOLOGY");
  }
  const blockedPublicConsent = await fetch(
    `${started.baseUrl}/api/v1/public/invoices/${encodeURIComponent(invoiceId)}/consent`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(policyVersions),
    }
  );
  assert.equal(blockedPublicConsent.status, 404);
  assert.equal(
    (await blockedPublicConsent.json()).error?.code,
    "PUBLIC_CUSTOMER_PAYMENT_DISABLED_BY_TOPOLOGY",
    "the anonymous public consent route must be unreachable in local topology"
  );

  // The local topology does not create or persist a signed public payment
  // reference. Traceability remains anchored by the invoice and audit rows.
  const db = new Database(env.DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const storedRow = db
      .prepare(`SELECT payment_url FROM invoices WHERE id = ?`)
      .get(invoiceId);
    assert.equal(
      storedRow?.payment_url,
      "",
      "local topology must not create or persist a signed public payment URL"
    );
  } finally {
    db.close();
  }

  // Concurrency closure: duplicate consent POSTs can never produce two consent
  // rows or two audit entries. better-sqlite3 handlers serialize within the
  // server process and the insert re-checks inside one transaction, so the
  // loser observes the committed winner as an idempotent replay. A freshly
  // reissued (unconsented) invoice guarantees neither writer has an existing
  // row to replay, and a terminal holds exactly one active invoice.
  const raceReissue = await apiRequest(started.baseUrl, `/api/v1/invoices/${encodeURIComponent(invoiceId)}/reissue`, {
    method: "POST",
    headers: authHeaders(admin.token, { "content-type": "application/json", "idempotency-key": `race-reissue-${Date.now()}` }),
    body: "{}",
  });
  assert.equal(raceReissue.status, 201, JSON.stringify(raceReissue.data));
  const raceInvoiceId = raceReissue.data.invoice_id;
  const raceConsentBody = JSON.stringify({
    terms_version: raceReissue.data.customer_policy_consent.versions.terms_version,
    privacy_version: raceReissue.data.customer_policy_consent.versions.privacy_version,
    refund_policy_version: raceReissue.data.customer_policy_consent.versions.refund_policy_version,
  });
  const raceConsentPath = `/api/v1/invoices/${encodeURIComponent(raceInvoiceId)}/policy-consent`;
  const [firstWrite, secondWrite] = await Promise.all([
    apiRequest(started.baseUrl, raceConsentPath, {
      method: "POST",
      headers: authHeaders(admin.token, { "content-type": "application/json" }),
      body: raceConsentBody,
    }),
    apiRequest(started.baseUrl, raceConsentPath, {
      method: "POST",
      headers: authHeaders(relogin.data.token, { "content-type": "application/json" }),
      body: raceConsentBody,
    }),
  ]);
  const writeStatuses = [firstWrite.status, secondWrite.status].sort();
  assert.deepEqual(writeStatuses, [200, 201], JSON.stringify([firstWrite.data, secondWrite.data]));
  const winnerWrite = firstWrite.status === 201 ? firstWrite : secondWrite;
  const loserWrite = firstWrite.status === 201 ? secondWrite : firstWrite;
  assert.equal(loserWrite.data.idempotent_replay, true);
  assert.equal(loserWrite.data.consent_id, winnerWrite.data.consent_id);
  const consentDb = new Database(env.DB_PATH, { readonly: true, fileMustExist: true });
  try {
    assert.equal(
      consentDb.prepare(`SELECT COUNT(*) AS count FROM invoice_consents WHERE invoice_id = ?`).get(raceInvoiceId).count,
      1,
    );
    assert.equal(
      consentDb
        .prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'customer_policy_consent_staff' AND target_id = ?`)
        .get(raceInvoiceId).count,
      1,
    );
  } finally {
    consentDb.close();
  }

  // Policy revision closure: republishing the store policies must never
  // retroactively alter an already-consented invoice. The consented invoice
  // keeps its frozen policy snapshot, its recorded consent, and its exact
  // transfer URI; only newly issued invoices bind to the revised versions.
  const revisedContents = {
    terms: "Local terminal terms\nVersion: 2026-09-01\n",
    privacy: "Local terminal privacy\nVersion: 2026-09-01\n",
    refund: "Local terminal refund policy\nVersion: 2026-09-01\n",
  };
  const revisedVersions = {
    terms_version: "2026-09-01",
    privacy_version: "2026-09-01",
    refund_policy_version: "2026-09-01",
  };
  const republish = await apiRequest(
    started.baseUrl,
    `/api/v1/admin/stores/${encodeURIComponent(admin.storeId)}/customer-policies`,
    {
      method: "PATCH",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `local-policy-revision-${Date.now()}`,
      }),
      body: JSON.stringify({
        terms_url: `${PUBLIC_POLICY_ORIGIN}/terms`,
        privacy_url: `${PUBLIC_POLICY_ORIGIN}/privacy`,
        refund_policy_url: `${PUBLIC_POLICY_ORIGIN}/refund-policy`,
        ...revisedVersions,
        terms_hash: hashPolicyContent(revisedContents.terms),
        privacy_hash: hashPolicyContent(revisedContents.privacy),
        refund_policy_hash: hashPolicyContent(revisedContents.refund),
        contents: revisedContents,
      }),
    }
  );
  assert.equal(republish.status, 200, JSON.stringify(republish.data));

  const afterRepublish = await getInvoice(started.baseUrl, admin.token, raceInvoiceId);
  assert.equal(afterRepublish.status, 200, JSON.stringify(afterRepublish.data));
  assert.equal(afterRepublish.data.customer_policy_consent?.recorded, true);
  assert.equal(afterRepublish.data.customer_policy_consent?.versions?.terms_version, "2026-08-26");
  const raceExpectedUri = `ethereum:${OFFICIAL_JPYC_TOKEN.toLowerCase()}@137/transfer?address=${String(afterRepublish.data.receive_address).toLowerCase()}&uint256=${expectedAtomic}`;
  assert.equal(afterRepublish.data.payment_uri, raceExpectedUri);

  const oldVersionReplay = await apiRequest(started.baseUrl, raceConsentPath, {
    method: "POST",
    headers: authHeaders(admin.token, { "content-type": "application/json" }),
    body: raceConsentBody,
  });
  assert.equal(oldVersionReplay.status, 200);
  assert.equal(oldVersionReplay.data.idempotent_replay, true);

  const revisedInvoice = await apiRequest(started.baseUrl, `/api/v1/invoices/${encodeURIComponent(raceInvoiceId)}/reissue`, {
    method: "POST",
    headers: authHeaders(admin.token, { "content-type": "application/json", "idempotency-key": `revised-reissue-${Date.now()}` }),
    body: "{}",
  });
  assert.equal(revisedInvoice.status, 201, JSON.stringify(revisedInvoice.data));
  assert.equal(revisedInvoice.data.customer_policy_consent?.versions?.terms_version, "2026-09-01");
  assert.ok(!revisedInvoice.data.qr_payload, "the revised invoice still withholds its URI before its own consent");
  const staleConsentAttempt = await apiRequest(
    started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(revisedInvoice.data.invoice_id)}/policy-consent`,
    {
      method: "POST",
      headers: authHeaders(admin.token, { "content-type": "application/json" }),
      body: raceConsentBody,
    }
  );
  assert.equal(staleConsentAttempt.status, 409);
  assert.equal(staleConsentAttempt.data.error?.code, "POLICY_VERSION_MISMATCH");
});

test("local_store_terminal requires a fresh policy consent after a reissued invoice", async (t) => {
  const siteFixture = policySiteFixture();
  const port = 21000 + ((process.pid * 61 + 13) % 20000);
  const env = productionServerEnv({
    NODE_OPTIONS: "--import=./tests/helpers/mock-policy-site.mjs",
    POLICY_SITE_FIXTURE_PATH: siteFixture.file,
    APP_ENV: "development",
    COMMERCIAL_GO_MODE: "false",
    DEPLOYMENT_STAGE: "development",
    DEPLOYMENT_TOPOLOGY: "local_store_terminal",
    APP_PORT: String(port),
    APP_HOST: `http://127.0.0.1:${port}`,
    PAY_BASE_URL: `http://127.0.0.1:${port}`,
    CORS_ALLOW_ORIGINS: `http://127.0.0.1:${port}`,
    PUBLIC_POLICY_ORIGIN: PUBLIC_POLICY_ORIGIN,
    PUBLIC_BASE_URL: PUBLIC_POLICY_ORIGIN,
    TRUST_PROXY: "false",
    TRUST_PROXY_HOPS: "",
    PUBLIC_PAYMENT_PAGE_ENABLED: "false",
    BACKUP_DIR: "./runtime/backups",
    LOCAL_TERMINAL_OPERATOR_READINESS_REF: "MAC-READY-2026-08",
    RPC_URLS_137: "https://polygon-rpc.example.com",
    RECEIVE_ADDRESS_DEV_AUTO_VERIFY: "true",
  });

  const started = await startServerProcess(CWD, env);
  t.after(async () => { await stopServerProcess(started.proc); siteFixture.cleanup(); });

  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });
  const published = await apiRequest(
    started.baseUrl,
    `/api/v1/admin/stores/${encodeURIComponent(admin.storeId)}/customer-policies`,
    {
      method: "PATCH",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `reissue-policy-${Date.now()}`,
      }),
      body: JSON.stringify({
        terms_url: `${PUBLIC_POLICY_ORIGIN}/terms`,
        privacy_url: `${PUBLIC_POLICY_ORIGIN}/privacy`,
        refund_policy_url: `${PUBLIC_POLICY_ORIGIN}/refund-policy`,
        terms_version: "2026-08-26",
        privacy_version: "2026-08-26",
        refund_policy_version: "2026-08-26",
        terms_hash: hashPolicyContent(LOCAL_POLICY_CONTENTS.terms),
        privacy_hash: hashPolicyContent(LOCAL_POLICY_CONTENTS.privacy),
        refund_policy_hash: hashPolicyContent(LOCAL_POLICY_CONTENTS.refund),
        contents: LOCAL_POLICY_CONTENTS,
      }),
    }
  );
  assert.equal(published.status, 200, JSON.stringify(published.data));
  const first = await createInvoice(started.baseUrl, admin.token, 900, `reissue-consent-a-${Date.now()}`);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const firstId = first.data.invoice_id;
  const firstRecord = await apiRequest(
    started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(firstId)}/policy-consent`,
    {
      method: "POST",
      headers: authHeaders(admin.token, { "content-type": "application/json" }),
      body: JSON.stringify(first.data.customer_policy_consent.versions),
    }
  );
  assert.equal(firstRecord.status, 201, JSON.stringify(firstRecord.data));
  const firstAfter = await getInvoice(started.baseUrl, admin.token, firstId);
  assert.ok(firstAfter.data.payment_uri, "consented invoice must expose the transfer URI");

  const second = await apiRequest(started.baseUrl, `/api/v1/invoices/${encodeURIComponent(firstId)}/reissue`, {
    method: "POST",
    headers: authHeaders(admin.token, { "content-type": "application/json", "idempotency-key": `reissue-${Date.now()}` }),
    body: "{}",
  });
  assert.equal(second.status, 201, JSON.stringify(second.data));
  const secondId = second.data.invoice_id;
  assert.notEqual(secondId, firstId);
  // The reissued invoice starts unconsented: no transfer URI until consent again.
  assert.ok(!second.data.qr_payload, "a reissued invoice response must not expose a transfer URI");
  assert.equal(second.data.customer_policy_consent?.recorded, false);
  const secondGet = await getInvoice(started.baseUrl, admin.token, secondId);
  assert.ok(!secondGet.data.payment_uri, "the new invoice stays unconsented until its own consent row exists");

  const expiredInvoiceConsent = await apiRequest(
    started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(firstId)}/policy-consent`,
    {
      method: "POST",
      headers: authHeaders(admin.token, { "content-type": "application/json" }),
      body: JSON.stringify(first.data.customer_policy_consent.versions),
    }
  );
  assert.equal(expiredInvoiceConsent.status, 409);
  assert.equal(expiredInvoiceConsent.data.error?.code, "POLICY_CONSENT_NOT_ALLOWED");
});

test("local_store_terminal refuses consent when an invoice policy URL is not exactly bound to the configured Site", async (t) => {
  const port = 21000 + ((process.pid * 67 + 19) % 20000);
  const env = productionServerEnv({
    APP_ENV: "development",
    COMMERCIAL_GO_MODE: "false",
    DEPLOYMENT_STAGE: "development",
    DEPLOYMENT_TOPOLOGY: "local_store_terminal",
    APP_PORT: String(port),
    APP_HOST: `http://127.0.0.1:${port}`,
    PAY_BASE_URL: `http://127.0.0.1:${port}`,
    CORS_ALLOW_ORIGINS: `http://127.0.0.1:${port}`,
    PUBLIC_POLICY_ORIGIN: PUBLIC_POLICY_ORIGIN,
    PUBLIC_BASE_URL: PUBLIC_POLICY_ORIGIN,
    TRUST_PROXY: "false",
    TRUST_PROXY_HOPS: "",
    PUBLIC_PAYMENT_PAGE_ENABLED: "false",
    BACKUP_DIR: "./runtime/backups",
    LOCAL_TERMINAL_OPERATOR_READINESS_REF: "MAC-READY-2026-08",
    RPC_URLS_137: "https://polygon-rpc.example.com",
    RECEIVE_ADDRESS_DEV_AUTO_VERIFY: "true",
  });
  const started = await startServerProcess(CWD, env);
  t.after(async () => stopServerProcess(started.proc));
  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });
  const versions = {
    terms_version: "2026-08-26",
    privacy_version: "2026-08-26",
    refund_policy_version: "2026-08-26",
  };
  const contents = {
    terms: "Mismatched local terminal terms\n",
    privacy: "Local terminal privacy\n",
    refund: "Local terminal refund policy\n",
  };
  const published = await apiRequest(
    started.baseUrl,
    `/api/v1/admin/stores/${encodeURIComponent(admin.storeId)}/customer-policies`,
    {
      method: "PATCH",
      headers: authHeaders(admin.token, {
        "content-type": "application/json",
        "idempotency-key": `mismatch-policy-${Date.now()}`,
      }),
      body: JSON.stringify({
        terms_url: `${PUBLIC_POLICY_ORIGIN}/terms-unapproved`,
        privacy_url: `${PUBLIC_POLICY_ORIGIN}/privacy`,
        refund_policy_url: `${PUBLIC_POLICY_ORIGIN}/refund-policy`,
        ...versions,
        terms_hash: hashPolicyContent(contents.terms),
        privacy_hash: hashPolicyContent(contents.privacy),
        refund_policy_hash: hashPolicyContent(contents.refund),
        contents,
      }),
    }
  );
  assert.equal(published.status, 200, JSON.stringify(published.data));
  const created = await createInvoice(started.baseUrl, admin.token, 500, `mismatch-site-${Date.now()}`);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.customer_policy_consent?.ready, false);
  assert.deepEqual(created.data.customer_policy_consent?.site_binding_mismatch_keys, ["terms"]);
  assert.ok(!created.data.payment_uri);

  const rejected = await apiRequest(
    started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(created.data.invoice_id)}/policy-consent`,
    {
      method: "POST",
      headers: authHeaders(admin.token, { "content-type": "application/json" }),
      body: JSON.stringify(versions),
    }
  );
  assert.equal(rejected.status, 503, JSON.stringify(rejected.data));
  assert.equal(rejected.data.error?.code, "POLICY_SITE_BINDING_MISMATCH");
  assert.deepEqual(rejected.data.error?.details?.mismatch_keys, ["terms"]);
  const afterReject = await getInvoice(started.baseUrl, admin.token, created.data.invoice_id);
  assert.equal(afterReject.data.customer_policy_consent?.recorded, false);
  assert.ok(!afterReject.data.payment_uri);
});

test("default public_cloud topology keeps the existing signed payment page behavior", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(CWD, env);
  t.after(async () => stopServerProcess(started.proc));

  const payPage = await fetch(`${started.baseUrl}/pay?ref=${encodeURIComponent("not-a-valid-ref")}`, {
    redirect: "manual",
  });
  assert.equal(payPage.status, 400);
  const payload = await payPage.json().catch(() => ({}));
  assert.equal(payload.error?.code, "INVALID_PAYMENT_REF");

  const health = await apiRequest(started.baseUrl, "/healthz");
  assert.equal(health.status, 200);
});

function runNode(scriptPath, args = [], env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [scriptPath, ...args],
      { cwd: CWD, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        resolve({ code: error?.code ?? 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
      }
    );
  });
}

const VALIDATOR_LOCAL_ENV = {
  APP_ENV: "production",
  DEPLOYMENT_TOPOLOGY: "local_store_terminal",
  APP_BIND_HOST: "127.0.0.1",
  TRUST_PROXY: "false",
  PUBLIC_POLICY_ORIGIN: PUBLIC_POLICY_ORIGIN,
  PUBLIC_BASE_URL: PUBLIC_POLICY_ORIGIN,
  APP_HOST: "http://127.0.0.1:4173",
  PAY_BASE_URL: "http://127.0.0.1:4173",
  INTERNAL_APP_ORIGIN: "http://127.0.0.1:4173",
  DB_PATH: "./runtime/data/app.db",
  WORKER_STATE_DB_PATH: "./runtime/worker-state/chain-137.db",
  BACKUP_DIR: "./runtime/backups",
  CORS_ALLOW_ORIGINS: "http://127.0.0.1:4173",
  CHAIN_ID: "137",
  ENABLED_PAYMENT_CHAIN_IDS: "137",
  RPC_URLS_137: "https://polygon-rpc.example.com",
  TOKEN_CONTRACT: OFFICIAL_JPYC_TOKEN,
  APPROVED_JPYC_TOKEN_CONTRACT: OFFICIAL_JPYC_TOKEN,
  TOKEN_DECIMALS: "18",
  RECIPIENT_ADDRESS: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  WALLET_ADAPTER_TYPE: "wallet_deeplink",
  LOCAL_TERMINAL_OPERATOR_READINESS_REF: "MAC-READY-2026-08",
  PUBLIC_PAYMENT_PAGE_ENABLED: "false",
};

test("validator passes local_store_terminal template preflight and asserts exact wallet transfer QR", async () => {
  const result = await runNode(
    "scripts/production-validation/validate-production-config.mjs",
    ["--deployment-topology", "local_store_terminal", "--skip-rpc", "--allow-empty"],
    VALIDATOR_LOCAL_ENV
  );
  assert.equal(result.code, 0, result.stdout || result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  const names = new Set(payload.checks.map((row) => row.name));
  for (const name of [
    "deployment_topology",
    "topology_local_loopback_bind",
    "topology_local_public_policy_origin",
    "topology_local_public_payment_page_disabled",
    "topology_local_no_public_payment_origin",
    "topology_local_direct_loopback_no_trusted_proxy",
    "topology_local_demo_controls_disabled",
    "topology_local_recipient_approval_input",
    "topology_local_backup_dir",
    "topology_local_worker_state_db_separation",
    "topology_local_mac_readiness_reference",
    "local_topology_wallet_transfer_qr_exactness",
  ]) {
    assert.ok(names.has(name), `missing validator check: ${name}`);
  }
});

test("validator rejects local_store_terminal without the Mac readiness reference", async () => {
  const result = await runNode(
    "scripts/production-validation/validate-production-config.mjs",
    ["--deployment-topology", "local_store_terminal", "--skip-rpc"],
    { ...VALIDATOR_LOCAL_ENV, LOCAL_TERMINAL_OPERATOR_READINESS_REF: "" }
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /LOCAL_TERMINAL_OPERATOR_READINESS_REF/);
});

test("validator fails closed when PUBLIC_PAYMENT_PAGE_ENABLED is not explicitly false", async () => {
  for (const flagValue of ["true", "", "0", "off", undefined]) {
    const env = { ...VALIDATOR_LOCAL_ENV };
    if (flagValue === undefined) delete env.PUBLIC_PAYMENT_PAGE_ENABLED;
    else env.PUBLIC_PAYMENT_PAGE_ENABLED = flagValue;
    const result = await runNode(
      "scripts/production-validation/validate-production-config.mjs",
      ["--deployment-topology", "local_store_terminal", "--skip-rpc"],
      env
    );
    assert.notEqual(result.code, 0, `expected failure for PUBLIC_PAYMENT_PAGE_ENABLED=${JSON.stringify(flagValue)}`);
    assert.match(result.stdout, /PUBLIC_PAYMENT_PAGE_ENABLED=false/);
  }
});

test("validator rejects an unknown deployment topology value", async () => {
  const result = await runNode(
    "scripts/production-validation/validate-production-config.mjs",
    ["--deployment-topology", "store_kiosk"],
    { ...VALIDATOR_LOCAL_ENV }
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /DEPLOYMENT_TOPOLOGY must be public_cloud or local_store_terminal/);
});
