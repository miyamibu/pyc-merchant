import crypto from "node:crypto";
import { verifyMessage } from "ethers";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const HASH_RE = /^[0-9a-f]{64}$/i;
const CONTROL_PROOF_TYPES = new Set([
  "eoa_signature",
  "eip1271_signature",
  "provider_attestation",
  "manifest_attestation",
  "test_fixture",
]);

function normalize(value) {
  return String(value ?? "").trim();
}

function normalizeAddress(value) {
  const raw = normalize(value).toLowerCase();
  return ADDRESS_RE.test(raw) ? raw : "";
}

function normalizeHash(value) {
  const raw = normalize(value).toLowerCase().replace(/^0x/, "");
  return HASH_RE.test(raw) ? raw : "";
}

export function buildReceiveAddressControlMessage({ address, chainId, tokenContract, sweepDestination } = {}) {
  return [
    "JPYC receive address control proof v1",
    `address:${normalizeAddress(address)}`,
    `chain_id:${normalize(chainId)}`,
    `token_contract:${normalizeAddress(tokenContract)}`,
    `sweep_destination:${normalizeAddress(sweepDestination)}`,
  ].join("\n");
}

export function hashControlPayload(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload ?? {}), "utf8").digest("hex");
}

export function buildReceiveAddressManifestMessage(payload = {}) {
  return [
    "JPYC receive address manifest v1",
    JSON.stringify(payload),
  ].join("\n");
}

export function verifyReceiveAddressControlProof(input = {}, { allowTestFixture = false, preverified = false } = {}) {
  const proofType = normalize(input.control_proof_type ?? input.controlProofType).toLowerCase();
  const address = normalizeAddress(input.address);
  const chainId = normalize(input.chain_id ?? input.chainId);
  const tokenContract = normalizeAddress(input.token_contract ?? input.tokenContract);
  const sweepDestination = normalizeAddress(input.sweep_destination ?? input.sweepDestination);
  const message = normalize(input.control_proof_message ?? input.controlProofMessage);
  const signature = normalize(input.control_proof_signature ?? input.controlProofSignature);
  const suppliedHash = normalizeHash(input.control_proof_payload_hash ?? input.controlProofPayloadHash);
  const expectedMessage = buildReceiveAddressControlMessage({
    address,
    chainId,
    tokenContract,
    sweepDestination,
  });
  const expectedHash = hashControlPayload({
    address,
    chain_id: chainId,
    token_contract: tokenContract,
    sweep_destination: sweepDestination,
    message: expectedMessage,
  });
  const errors = [];

  if (proofType === "test_fixture") {
    if (!allowTestFixture) errors.push("TEST_FIXTURE_PROOF_NOT_ALLOWED");
    return { ok: errors.length === 0, verified: errors.length === 0, errors, expected_message: expectedMessage, expected_hash: expectedHash };
  }

  if (proofType === "eoa_signature") {
    if (message !== expectedMessage) errors.push("CONTROL_PROOF_MESSAGE_MISMATCH");
    if (!signature) errors.push("CONTROL_PROOF_SIGNATURE_REQUIRED");
    if (!suppliedHash || suppliedHash !== expectedHash) errors.push("CONTROL_PROOF_PAYLOAD_HASH_MISMATCH");
    if (errors.length === 0) {
      try {
        const recovered = normalizeAddress(verifyMessage(message, signature));
        if (!recovered || recovered !== address) errors.push("CONTROL_PROOF_SIGNER_MISMATCH");
      } catch (_error) {
        errors.push("CONTROL_PROOF_SIGNATURE_INVALID");
      }
    }
    return { ok: errors.length === 0, verified: errors.length === 0, errors, expected_message: expectedMessage, expected_hash: expectedHash };
  }

  if (["eip1271_signature", "provider_attestation", "manifest_attestation"].includes(proofType)) {
    if (!preverified) errors.push("CONTROL_PROOF_RUNTIME_VERIFICATION_REQUIRED");
    if (!suppliedHash || suppliedHash !== expectedHash) errors.push("CONTROL_PROOF_PAYLOAD_HASH_MISMATCH");
    return { ok: errors.length === 0, verified: errors.length === 0, errors, expected_message: expectedMessage, expected_hash: expectedHash };
  }

  return { ok: false, verified: false, errors: ["CONTROL_PROOF_TYPE_REQUIRED"], expected_message: expectedMessage, expected_hash: expectedHash };
}

export function validateReceiveAddressControl(input = {}, { allowTestFixture = false } = {}) {
  const address = normalizeAddress(input.address);
  const chainId = normalize(input.chain_id ?? input.chainId);
  const tokenContract = normalizeAddress(input.token_contract ?? input.tokenContract);
  const proofType = normalize(input.control_proof_type ?? input.controlProofType).toLowerCase();
  const proofHash = normalizeHash(input.control_proof_payload_hash ?? input.controlProofPayloadHash);
  const controlVerifiedAt = normalize(input.control_verified_at ?? input.controlVerifiedAt);
  const sweepDestination = normalizeAddress(input.sweep_destination ?? input.sweepDestination);
  const sweepCapability = normalize(input.sweep_capability ?? input.sweepCapability).toLowerCase();
  const providerReference = normalize(input.provider_reference ?? input.providerReference);
  const errors = [];

  if (!address) errors.push("INVALID_ADDRESS");
  if (!/^\d+$/.test(chainId)) errors.push("INVALID_CHAIN_ID");
  if (!tokenContract) errors.push("INVALID_TOKEN_CONTRACT");
  if (!CONTROL_PROOF_TYPES.has(proofType)) errors.push("CONTROL_PROOF_TYPE_REQUIRED");
  if (proofType === "test_fixture" && !allowTestFixture) errors.push("TEST_FIXTURE_PROOF_NOT_ALLOWED");
  if (!proofHash) errors.push("CONTROL_PROOF_HASH_REQUIRED");
  if (!controlVerifiedAt || !Number.isFinite(new Date(controlVerifiedAt).getTime())) errors.push("CONTROL_VERIFICATION_TIMESTAMP_REQUIRED");
  if (!sweepDestination) errors.push("SWEEP_DESTINATION_REQUIRED");
  if (!sweepCapability || ["unknown", "unverified", "none"].includes(sweepCapability)) errors.push("SWEEP_CAPABILITY_UNVERIFIED");
  if (proofType === "provider_attestation" && !providerReference) errors.push("PROVIDER_REFERENCE_REQUIRED");

  const proofVerification = verifyReceiveAddressControlProof(input, {
    allowTestFixture,
    preverified: input._proof_verified === true,
  });
  if (!proofVerification.ok) errors.push(...proofVerification.errors);

  const ok = errors.length === 0;
  return {
    ok,
    activation_status: ok ? "available" : "pending_proof",
    errors,
    normalized: {
      address,
      chain_id: chainId || null,
      token_contract: tokenContract || null,
      control_proof_type: proofType || null,
      control_proof_payload_hash: proofHash || null,
      control_verified_at: controlVerifiedAt || null,
      sweep_destination: sweepDestination || null,
      sweep_capability: sweepCapability || null,
      provider_reference: providerReference || null,
      control_proof_message: proofType === "eoa_signature" ? normalize(input.control_proof_message ?? input.controlProofMessage) || null : null,
      control_proof_verified: proofVerification.verified,
      activation_status: ok ? "available" : "pending_proof",
    },
  };
}

export function isReceiveAddressAllocatable(row = {}) {
  return String(row.status || "") === "available"
    && String(row.activation_status || "") === "available"
    && Boolean(normalize(row.control_verified_at))
    && (row.control_proof_verified === true || Number(row.control_proof_verified || 0) === 1)
    && Boolean(normalizeHash(row.control_proof_payload_hash))
    && Boolean(normalizeAddress(row.sweep_destination))
    && !["", "unknown", "unverified", "none"].includes(normalize(row.sweep_capability).toLowerCase());
}

export function validateReceiveAddressManifest(input = {}, { addresses = [], chainId = "", requireProductionFields = false } = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const normalizedAddresses = [...new Set((Array.isArray(addresses) ? addresses : [])
    .map(normalizeAddress)
    .filter(Boolean))].sort();
  const manifestAddresses = Array.isArray(raw.addresses)
    ? [...new Set(raw.addresses.map(normalizeAddress).filter(Boolean))].sort()
    : normalizedAddresses;
  const normalized = {
    batch_id: normalize(raw.batch_id ?? raw.batchId),
    provider_id: normalize(raw.provider_id ?? raw.providerId),
    chain_id: normalize(raw.chain_id ?? raw.chainId ?? chainId),
    addresses: manifestAddresses,
    generated_at: normalize(raw.generated_at ?? raw.generatedAt),
    sweep_policy: normalize(raw.sweep_policy ?? raw.sweepPolicy),
    sha256: normalizeHash(raw.sha256 ?? raw.manifest_sha256 ?? raw.manifestSha256),
    signature: normalize(raw.signature ?? raw.manifest_signature ?? raw.manifestSignature),
    signer_address: normalizeAddress(raw.signer_address ?? raw.signerAddress ?? raw.manifest_signer_address),
    approval_ref: normalize(raw.approval_ref ?? raw.approvalRef ?? raw.manifest_approval_ref),
  };
  const canonicalPayload = {
    batch_id: normalized.batch_id,
    provider_id: normalized.provider_id,
    chain_id: normalized.chain_id,
    addresses: normalized.addresses,
    generated_at: normalized.generated_at,
    sweep_policy: normalized.sweep_policy,
  };
  const canonicalSha256 = hashControlPayload(canonicalPayload);
  const errors = [];
  if (!normalized.batch_id) errors.push("MANIFEST_BATCH_ID_REQUIRED");
  if (!normalized.provider_id) errors.push("MANIFEST_PROVIDER_ID_REQUIRED");
  if (normalized.chain_id !== normalize(chainId)) errors.push("MANIFEST_CHAIN_MISMATCH");
  if (normalized.addresses.length !== normalizedAddresses.length
    || normalized.addresses.some((address, index) => address !== normalizedAddresses[index])) {
    errors.push("MANIFEST_ADDRESS_LIST_MISMATCH");
  }
  if (!normalized.generated_at || !Number.isFinite(new Date(normalized.generated_at).getTime())) {
    errors.push("MANIFEST_GENERATED_AT_REQUIRED");
  }
  if (!normalized.sweep_policy) errors.push("MANIFEST_SWEEP_POLICY_REQUIRED");
  if (!normalized.sha256) errors.push("MANIFEST_SHA256_REQUIRED");
  if (normalized.sha256 && normalized.sha256 !== canonicalSha256) errors.push("MANIFEST_SHA256_MISMATCH");
  if (!normalized.signature) errors.push("MANIFEST_SIGNATURE_REQUIRED");
  if (!normalized.approval_ref) errors.push("MANIFEST_APPROVAL_REF_REQUIRED");
  let signatureStatus = normalized.signature ? "present_unverified" : "missing";
  if (normalized.signature && normalized.signer_address) {
    try {
      const recovered = normalizeAddress(verifyMessage(buildReceiveAddressManifestMessage(canonicalPayload), normalized.signature));
      if (recovered !== normalized.signer_address) errors.push("MANIFEST_SIGNATURE_SIGNER_MISMATCH");
      else signatureStatus = "verified_eoa";
    } catch (_error) {
      errors.push("MANIFEST_SIGNATURE_INVALID");
    }
  } else if (requireProductionFields) {
    errors.push("MANIFEST_SIGNER_ADDRESS_REQUIRED");
  }
  if (requireProductionFields && signatureStatus !== "verified_eoa") errors.push("MANIFEST_SIGNATURE_UNVERIFIED");
  return {
    ok: requireProductionFields ? errors.length === 0 : (errors.filter((error) => error === "MANIFEST_CHAIN_MISMATCH" || error === "MANIFEST_ADDRESS_LIST_MISMATCH" || error === "MANIFEST_SHA256_MISMATCH").length === 0),
    errors,
    normalized: {
      ...normalized,
      canonical_sha256: canonicalSha256,
      signature_status: signatureStatus,
    },
  };
}

export { CONTROL_PROOF_TYPES };
