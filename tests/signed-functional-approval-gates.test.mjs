import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  apiRequest,
  authHeaders,
  loginAs,
  productionServerEnv,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";
import { createRepositorySignedReleaseFixture } from "./helpers/signed-release-fixture.mjs";
import { loadReleaseManifest } from "../scripts/production-validation/validate-commercial-go.mjs";
import { validateSignedReleaseEvidence } from "../scripts/production-validation/signed-release-evidence.mjs";

const CWD = process.cwd();

async function loginBootstrapAdmin(started, env) {
  return loginAs(started.baseUrl, {
    terminalCode: env.BOOTSTRAP_TERMINAL_CODE,
    pin: env.BOOTSTRAP_ADMIN_PIN,
  });
}

async function requestExternalSignerExecution(started, token, suffix) {
  return apiRequest(started.baseUrl, "/api/v1/refunds/missing-refund/execute", {
    method: "POST",
    headers: authHeaders(token, {
      "content-type": "application/json",
      "idempotency-key": `signed-functional-${suffix}-${Date.now()}`,
    }),
    body: JSON.stringify({
      executor_type: "external_signer",
      execution_ref: `external-${suffix}`,
    }),
  });
}

test("legacy approval booleans and refs alone cannot unlock production functional gates", async (t) => {
  const env = productionServerEnv({ COMMERCIAL_GO_MODE: "true" });
  const started = await startServerProcess(CWD, env);
  t.after(async () => stopServerProcess(started.proc));
  const admin = await loginBootstrapAdmin(started, env);

  const auditExport = await apiRequest(started.baseUrl, "/api/v1/audit-logs/export?format=json&limit=10", {
    headers: authHeaders(admin.token),
  });
  assert.equal(auditExport.status, 503);
  assert.equal(auditExport.data.error.code, "PRIVACY_POLICY_NOT_APPROVED");
  assert.equal(auditExport.data.error.details.privacy.source, "release_bound_signed_manifest");
  assert.equal(auditExport.data.error.details.privacy.ok, false);
  assert.equal(auditExport.data.error.details.appi.ok, false);

  const externalSigner = await requestExternalSignerExecution(started, admin.token, "legacy-only");
  assert.equal(externalSigner.status, 503);
  assert.equal(externalSigner.data.error.code, "LEGAL_GATE_NOT_APPROVED");
  assert.equal(externalSigner.data.error.details.approval_source, "release_bound_signed_manifest");
  assert.ok(externalSigner.data.error.details.blockers.includes("release_manifest_invalid"));
});

test("release-bound signed approvals unlock only their production functional gates", async (t) => {
  const fixture = createRepositorySignedReleaseFixture(CWD);
  t.after(() => fixture.cleanup());
  const env = productionServerEnv({
    COMMERCIAL_GO_MODE: "true",
    ...fixture.env,
  });
  const originalPath = process.env.PATH;
  let releaseResult;
  try {
    process.env.PATH = env.PATH;
    releaseResult = loadReleaseManifest(env.RELEASE_MANIFEST, env, { root: CWD });
  } finally {
    process.env.PATH = originalPath;
  }
  assert.equal(releaseResult.ok, true, JSON.stringify(releaseResult.blockers));
  const signedEvidence = validateSignedReleaseEvidence({
    releaseManifestResult: releaseResult,
    evidenceDir: env.COMMERCIAL_EVIDENCE_DIR,
    env,
    root: CWD,
    releaseMode: env.RELEASE_MODE,
  });
  assert.equal(signedEvidence.ok, true, JSON.stringify(signedEvidence.blockers));
  const started = await startServerProcess(CWD, env);
  t.after(async () => stopServerProcess(started.proc));
  const admin = await loginBootstrapAdmin(started, env);

  const ready = await apiRequest(started.baseUrl, "/readyz", {
    headers: { authorization: `Bearer ${env.METRICS_SECRET}` },
  });
  const releaseDiagnostics = JSON.stringify({
    blockers: ready.data.blockers,
    release_blockers: ready.data.release_blockers,
    approvals: ready.data.approvals,
  });
  assert.equal(ready.data.release_manifest_gate, true, releaseDiagnostics);
  assert.equal(ready.data.release_evidence_binding_gate, true, releaseDiagnostics);
  assert.equal(ready.data.legal_gate, true);
  assert.equal(ready.data.aml_gate, true);
  assert.equal(ready.data.privacy_gate, true);
  assert.equal(ready.data.appi_gate, true);

  const auditExport = await apiRequest(started.baseUrl, "/api/v1/audit-logs/export?format=json&limit=10", {
    headers: authHeaders(admin.token),
  });
  assert.equal(auditExport.status, 200, JSON.stringify(auditExport.data));

  const externalSigner = await requestExternalSignerExecution(started, admin.token, "signed");
  assert.equal(externalSigner.status, 404, JSON.stringify(externalSigner.data));
  assert.equal(externalSigner.data.error.code, "NOT_FOUND");
});

test("high-value, external-signer, and audit-export routes share the functional approval evaluator", () => {
  const source = fs.readFileSync("src/server.mjs", "utf8");
  const invoiceRoute = source.slice(
    source.indexOf('app.post("/api/v1/invoices"'),
    source.indexOf('app.get("/api/v1/invoices"'),
  );
  const refundExecutionRoute = source.slice(
    source.indexOf('app.post("/api/v1/refunds/:refundId/execute"'),
    source.indexOf('app.post("/api/v1/refunds/:refundId/retry"'),
  );
  const auditExportRoute = source.slice(
    source.indexOf('app.get("/api/v1/audit-logs/export"'),
    source.indexOf('app.get("/api/v1/settlements/daily-status"'),
  );

  assert.match(invoiceRoute, /evaluateFunctionalApprovalGate\("aml"\)/);
  assert.doesNotMatch(invoiceRoute, /!AML_POLICY_APPROVED/);
  assert.match(refundExecutionRoute, /evaluateFunctionalApprovalGate\("legal"\)/);
  assert.doesNotMatch(refundExecutionRoute, /!LEGAL_GATE_APPROVED/);
  assert.match(auditExportRoute, /evaluateFunctionalApprovalGate\("privacy", releaseGate\)/);
  assert.match(auditExportRoute, /evaluateFunctionalApprovalGate\("appi", releaseGate\)/);
  assert.doesNotMatch(auditExportRoute, /PRIVACY_POLICY_APPROVED|APPI_POLICY_APPROVED/);
});
