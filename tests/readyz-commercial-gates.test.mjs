import test from "node:test";
import assert from "node:assert/strict";
import {
  apiRequest,
  productionServerEnv,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();

test("readyz returns commercial gate fields and not-ready when blockers exist", async (t) => {
  const env = productionServerEnv({
    COMMERCIAL_GO_MODE: "true",
    SETTLEMENT_UNRESOLVED_REVIEW_POLICY: "warn",
  });
  const started = await startServerProcess(CWD, env);

  t.after(async () => {
    await stopServerProcess(started.proc);
  });

  const ready = await apiRequest(started.baseUrl, "/readyz", {
    headers: { authorization: `Bearer ${env.METRICS_SECRET}` },
  });

  assert.equal(ready.status, 503);
  assert.equal(typeof ready.data.app_env, "string");
  assert.equal(typeof ready.data.commercial_go_mode, "boolean");
  assert.equal(typeof ready.data.legal_gate, "boolean");
  assert.equal(typeof ready.data.aml_gate, "boolean");
  assert.equal(typeof ready.data.privacy_gate, "boolean");
  assert.equal(typeof ready.data.appi_gate, "boolean");
  assert.equal(typeof ready.data.jpyc_contract_gate, "boolean");
  assert.equal(typeof ready.data.confirmation_policy_gate, "boolean");
  assert.equal(typeof ready.data.backscan_policy_gate, "boolean");
  assert.equal(typeof ready.data.refund_treasury_approval_gate, "boolean");
  assert.equal(typeof ready.data.policy_urls_gate, "boolean");
  assert.equal(typeof ready.data.wallet_evidence_gate, "boolean");
  assert.equal(typeof ready.data.real_payment_evidence_gate, "boolean");
  assert.equal(typeof ready.data.tls_evidence_gate, "boolean");
  assert.equal(typeof ready.data.store_ops_drill_gate, "boolean");
  assert.equal(typeof ready.data.poc_package_gate, "boolean");
  assert.equal(typeof ready.data.performance_evidence_gate, "boolean");
  assert.equal(typeof ready.data.release_evidence_binding_gate, "boolean");
  assert.equal(typeof ready.data.release_mode_gate, "boolean");
  assert.equal(typeof ready.data.limited_pilot_cap_gate, "boolean");
  assert.equal(typeof ready.data.audit_chain_gate, "boolean");
  assert.equal(typeof ready.data.settlement_policy_gate, "boolean");
  assert.equal(typeof ready.data.refund_policy_gate, "boolean");
  assert.equal(typeof ready.data.dangerous_flags_gate, "boolean");
  assert.equal(typeof ready.data.commercial_verdict, "string");
  assert.ok(Array.isArray(ready.data.blockers));
  assert.ok(ready.data.blockers.includes("policy_urls_gate"));
  assert.ok(ready.data.blockers.includes("poc_package_gate"));
  assert.equal(ready.data.legal_gate, false, "env approval refs alone must not produce a signed legal gate pass");
  assert.ok(ready.data.blockers.includes("release_evidence_binding_gate"));
  assert.equal(typeof ready.data.approvals, "object");
  assert.equal(ready.data.approvals.legal, undefined, "missing signed approval manifest must not expose env approval as signed");
});
