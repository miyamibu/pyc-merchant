import test from "node:test";
import assert from "node:assert/strict";
import {
  REQUIRED_BOOLEAN_GATES,
  REQUIRED_SIGNED_APPROVALS,
  validatePublicReadinessPayload,
} from "../scripts/deploy/validate-readiness-payload.mjs";

const RELEASE_ID = "01K00000000000000000000000";

function validPayload(mode = "commercial") {
  const payload = {
    ok: true,
    acceptance_gate_required: true,
    release_id: RELEASE_ID,
    release_mode: mode,
    commercial_verdict: mode === "limited" ? "LIMITED_PILOT_GO" : "COMMERCIAL_GO_10",
    blockers: [],
    approvals: {},
  };
  for (const gate of REQUIRED_BOOLEAN_GATES) payload[gate] = true;
  for (const approvalId of REQUIRED_SIGNED_APPROVALS) payload.approvals[approvalId] = { ok: true, errors: [] };
  return payload;
}

test("public host readiness accepts only a complete signed commercial gate", () => {
  const result = validatePublicReadinessPayload(validPayload(), {
    expectedReleaseId: RELEASE_ID,
    expectedReleaseMode: "commercial",
  });
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("public host readiness rejects unknown or legacy verdicts", () => {
  for (const verdict of [undefined, "READY", "CONDITIONAL_NO_GO_FOR_COMMERCIAL", "COMMERCIAL_GO"] ) {
    const payload = validPayload();
    payload.commercial_verdict = verdict;
    const result = validatePublicReadinessPayload(payload, {
      expectedReleaseId: RELEASE_ID,
      expectedReleaseMode: "commercial",
    });
    assert.equal(result.ok, false, `unexpectedly accepted verdict ${String(verdict)}`);
    assert.ok(result.errors.includes("verdict_unknown_or_mode_mismatch"));
  }
});

test("public host readiness rejects a missing gate, approval, or release binding", () => {
  const cases = [
    (payload) => { delete payload.refund_treasury_approval_gate; },
    (payload) => { delete payload.release_evidence_binding_gate; },
    (payload) => { delete payload.approvals.refund_treasury; },
    (payload) => { payload.release_id = "01K11111111111111111111111"; },
    (payload) => { payload.blockers = ["release_manifest_gate"]; },
  ];
  for (const mutate of cases) {
    const payload = validPayload();
    mutate(payload);
    const result = validatePublicReadinessPayload(payload, {
      expectedReleaseId: RELEASE_ID,
      expectedReleaseMode: "commercial",
    });
    assert.equal(result.ok, false);
  }
});

test("public host readiness binds limited verdict to limited mode", () => {
  const payload = validPayload("limited");
  assert.equal(validatePublicReadinessPayload(payload, {
    expectedReleaseId: RELEASE_ID,
    expectedReleaseMode: "limited",
  }).ok, true);
  payload.commercial_verdict = "COMMERCIAL_GO_10";
  assert.equal(validatePublicReadinessPayload(payload, {
    expectedReleaseId: RELEASE_ID,
    expectedReleaseMode: "limited",
  }).ok, false);
});
