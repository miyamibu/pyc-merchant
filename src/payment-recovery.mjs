export const RECOVERY_REPORT_STATUSES = Object.freeze({
  VERIFIED_WRONG_CHAIN: "verified_wrong_chain",
  VERIFIED_WRONG_TOKEN: "verified_wrong_token",
  CUSTOMER_REPORTED_WRONG_CHAIN: "customer_reported_wrong_chain",
  CUSTOMER_REPORTED_WRONG_TOKEN: "customer_reported_wrong_token",
  UNVERIFIED_REPORT: "unverified_report",
  VERIFIED_MATCH: "verified_match",
});

export const RECOVERY_REPORT_ISSUES = Object.freeze({
  WRONG_CHAIN: "wrong_chain",
  WRONG_TOKEN: "wrong_token",
});

export const READ_ONLY_RECOVERY_CHAIN_IDS = Object.freeze(["1", "43114"]);

const RECOVERY_CHAIN_SET = new Set(READ_ONLY_RECOVERY_CHAIN_IDS);
const TX_HASH_RE = /^0x[0-9a-f]{64}$/i;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

function normalize(value) {
  return String(value ?? "").trim();
}

function normalizeAddress(value) {
  const raw = normalize(value).toLowerCase();
  return ADDRESS_RE.test(raw) ? raw : "";
}

export function normalizeRecoveryReportInput(input = {}) {
  const chainId = normalize(input.chain_id ?? input.chainId);
  const txHash = normalize(input.tx_hash ?? input.txHash).toLowerCase();
  const reportedIssue = normalize(input.reported_issue ?? input.reportedIssue).toLowerCase();
  const reporterType = normalize(input.reporter_type ?? input.reporterType).toLowerCase() || "customer";
  const errors = [];
  if (!RECOVERY_CHAIN_SET.has(chainId)) errors.push("chain_id must be 1 or 43114");
  if (!TX_HASH_RE.test(txHash)) errors.push("tx_hash must be a 0x-prefixed 32-byte hash");
  if (reportedIssue && !Object.values(RECOVERY_REPORT_ISSUES).includes(reportedIssue)) {
    errors.push("reported_issue must be wrong_chain or wrong_token");
  }
  if (!["customer", "staff"].includes(reporterType)) errors.push("reporter_type is invalid");
  return {
    ok: errors.length === 0,
    errors,
    chainId,
    txHash,
    reportedIssue: reportedIssue || null,
    reporterType,
  };
}

export function classifyRecoveryReport({
  invoiceChainId,
  requestedChainId,
  officialTokenContract,
  expectedRecipient,
  transferLogs = [],
  rpcVerified = false,
  receiptFound = false,
  reportedIssue = null,
  reporterType = "customer",
} = {}) {
  const invoiceChain = normalize(invoiceChainId);
  const requestedChain = normalize(requestedChainId);
  const officialToken = normalizeAddress(officialTokenContract);
  const recipient = normalizeAddress(expectedRecipient);
  const logs = Array.isArray(transferLogs) ? transferLogs : [];
  const recipientLogs = recipient
    ? logs.filter((log) => normalizeAddress(log.to_address ?? log.to) === recipient)
    : logs;
  const officialLogs = recipientLogs.filter(
    (log) => normalizeAddress(log.token_contract ?? log.tokenContract) === officialToken
  );
  const nonOfficialLogs = recipientLogs.filter(
    (log) => normalizeAddress(log.token_contract ?? log.tokenContract) !== officialToken
  );
  const chainDiffers = invoiceChain && requestedChain && invoiceChain !== requestedChain;

  if (rpcVerified && receiptFound && chainDiffers && officialLogs.length > 0) {
    return {
      status: RECOVERY_REPORT_STATUSES.VERIFIED_WRONG_CHAIN,
      evidence: { recipient_match: true, official_token_transfer_count: officialLogs.length },
    };
  }
  if (rpcVerified && receiptFound && !chainDiffers && nonOfficialLogs.length > 0) {
    return {
      status: RECOVERY_REPORT_STATUSES.VERIFIED_WRONG_TOKEN,
      evidence: { recipient_match: true, non_official_token_transfer_count: nonOfficialLogs.length },
    };
  }
  if (rpcVerified && receiptFound && !chainDiffers && officialLogs.length > 0) {
    return {
      status: RECOVERY_REPORT_STATUSES.VERIFIED_MATCH,
      evidence: { recipient_match: true, official_token_transfer_count: officialLogs.length },
    };
  }

  if (reporterType === "customer" && reportedIssue === RECOVERY_REPORT_ISSUES.WRONG_CHAIN) {
    return {
      status: RECOVERY_REPORT_STATUSES.CUSTOMER_REPORTED_WRONG_CHAIN,
      evidence: { rpc_verified: Boolean(rpcVerified), receipt_found: Boolean(receiptFound) },
    };
  }
  if (reporterType === "customer" && reportedIssue === RECOVERY_REPORT_ISSUES.WRONG_TOKEN) {
    return {
      status: RECOVERY_REPORT_STATUSES.CUSTOMER_REPORTED_WRONG_TOKEN,
      evidence: { rpc_verified: Boolean(rpcVerified), receipt_found: Boolean(receiptFound) },
    };
  }
  return {
    status: RECOVERY_REPORT_STATUSES.UNVERIFIED_REPORT,
    evidence: { rpc_verified: Boolean(rpcVerified), receipt_found: Boolean(receiptFound) },
  };
}
