const VERDICT_BY_MODE = Object.freeze({
  limited: "LIMITED_PILOT_GO",
  commercial: "COMMERCIAL_GO_10",
});

const REQUIRED_BOOLEAN_GATES = Object.freeze([
  "database_gate",
  "worker_gate",
  "rpc_runtime_gate",
  "clock_gate",
  "receive_address_pool_gate",
  "legal_gate",
  "aml_gate",
  "privacy_gate",
  "appi_gate",
  "jpyc_contract_gate",
  "confirmation_policy_gate",
  "backscan_policy_gate",
  "refund_treasury_approval_gate",
  "release_selection_gate",
  "release_manifest_gate",
  "release_evidence_binding_gate",
  "release_mode_gate",
  "limited_pilot_cap_gate",
  "policy_urls_gate",
  "wallet_evidence_gate",
  "real_payment_evidence_gate",
  "tls_evidence_gate",
  "store_ops_drill_gate",
  "poc_package_gate",
  "performance_evidence_gate",
  "audit_chain_gate",
  "settlement_policy_gate",
  "refund_policy_gate",
  "dangerous_flags_gate",
  "chain_reorg_gate",
  "chain_runtime_registry_gate",
]);

const REQUIRED_SIGNED_APPROVALS = Object.freeze([
  "legal",
  "aml",
  "privacy",
  "appi",
  "jpyc_contract",
  "confirmation_policy",
  "backscan_policy",
  "refund_treasury",
]);

export function validatePublicReadinessPayload(payload, {
  expectedReleaseId = "",
  expectedReleaseMode = "",
} = {}) {
  const errors = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, errors: ["payload_invalid"] };
  }
  const mode = String(payload.release_mode || "").trim().toLowerCase();
  const expectedMode = String(expectedReleaseMode || "").trim().toLowerCase();
  if (!Object.hasOwn(VERDICT_BY_MODE, mode)) errors.push("release_mode_unknown_or_missing");
  if (!Object.hasOwn(VERDICT_BY_MODE, expectedMode)) errors.push("expected_release_mode_unknown_or_missing");
  if (mode !== expectedMode) errors.push("release_mode_mismatch");

  const releaseId = String(payload.release_id || "").trim();
  const expectedId = String(expectedReleaseId || "").trim();
  if (!releaseId || !expectedId) errors.push("release_id_missing");
  else if (releaseId !== expectedId) errors.push("release_id_mismatch");

  if (payload.ok !== true) errors.push("readiness_not_ok");
  if (payload.acceptance_gate_required !== true) errors.push("acceptance_gate_not_required");
  const expectedVerdict = VERDICT_BY_MODE[mode];
  if (!expectedVerdict || payload.commercial_verdict !== expectedVerdict) {
    errors.push("verdict_unknown_or_mode_mismatch");
  }
  if (!Array.isArray(payload.blockers) || payload.blockers.length !== 0) errors.push("blockers_not_empty");

  for (const gate of REQUIRED_BOOLEAN_GATES) {
    if (payload[gate] !== true) errors.push(`${gate}_not_true`);
  }
  if (!payload.approvals || typeof payload.approvals !== "object" || Array.isArray(payload.approvals)) {
    errors.push("signed_approvals_missing");
  } else {
    for (const approvalId of REQUIRED_SIGNED_APPROVALS) {
      if (payload.approvals[approvalId]?.ok !== true) errors.push(`signed_approval_${approvalId}_not_true`);
    }
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

export { REQUIRED_BOOLEAN_GATES, REQUIRED_SIGNED_APPROVALS, VERDICT_BY_MODE };
