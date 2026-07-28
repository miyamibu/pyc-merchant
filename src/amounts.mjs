export const TOKEN_DECIMALS = 18;
export const LEDGER_DECIMALS = 6;
export const LEDGER_BASE_UNIT_SCALE = "1000000";
export const AMOUNT_SCALE_VERSION = "token-18-ledger-6-v1";

function normalizeScaleInput(scaleInput) {
  const raw = String(scaleInput ?? "").trim();
  if (!/^[0-9]+$/.test(raw) || raw === "0") {
    throw new Error("scale must be a positive integer string");
  }
  return raw;
}

export function scaleToDecimals(scaleInput) {
  const scale = normalizeScaleInput(scaleInput);
  if (!/^10*$/.test(scale)) {
    throw new Error("scale must be power-of-10");
  }
  return scale.length - 1;
}

function normalizeDecimalString(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("decimal string is required");
  if (!/^[+-]?\d+(\.\d+)?$/.test(raw)) {
    throw new Error("invalid decimal format");
  }
  return raw;
}

export function parseDecimalToBaseUnits(decimalString, decimalsInput) {
  const decimals = Number(decimalsInput);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("decimals must be an integer between 0 and 36");
  }
  const normalized = normalizeDecimalString(decimalString);
  const negative = normalized.startsWith("-");
  if (negative) {
    throw new Error("amount must be non-negative");
  }
  const unsigned = normalized.startsWith("+") ? normalized.slice(1) : normalized;
  const [wholeRaw, fractionRaw = ""] = unsigned.split(".");
  const whole = wholeRaw.replace(/^0+(?=\d)/, "") || "0";
  if (fractionRaw.length > decimals) {
    throw new Error("too many decimal places");
  }
  const fraction = fractionRaw.padEnd(decimals, "0");
  const joined = `${whole}${fraction}`.replace(/^0+(?=\d)/, "") || "0";
  return joined;
}

export function formatBaseUnitsForDisplay(baseUnitsString, decimalsInput) {
  const decimals = Number(decimalsInput);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("decimals must be an integer between 0 and 36");
  }
  const raw = String(baseUnitsString ?? "").trim();
  if (!/^[0-9]+$/.test(raw)) throw new Error("base units must be unsigned integer string");
  if (decimals === 0) return raw.replace(/^0+(?=\d)/, "") || "0";

  const normalized = raw.replace(/^0+(?=\d)/, "") || "0";
  const padded = normalized.padStart(decimals + 1, "0");
  const splitAt = padded.length - decimals;
  const whole = padded.slice(0, splitAt).replace(/^0+(?=\d)/, "") || "0";
  const frac = padded.slice(splitAt).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function compareBaseUnits(left, right) {
  const a = parseUnsignedIntegerString(left, "left");
  const b = parseUnsignedIntegerString(right, "right");
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

/**
 * Parse a monetary integer without ever coercing it through Number. Atomic
 * token values can exceed JavaScript's safe integer range and must remain
 * decimal strings at API/DB boundaries.
 */
export function parseUnsignedIntegerString(value, label = "amount") {
  const raw = String(value ?? "").trim();
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${label} must be an unsigned integer string`);
  }
  return BigInt(raw);
}

export function convertBaseUnitsBetweenDecimals(amountBaseUnitsString, fromDecimalsInput, toDecimalsInput) {
  const fromDecimals = Number(fromDecimalsInput);
  const toDecimals = Number(toDecimalsInput);
  if (!Number.isInteger(fromDecimals) || fromDecimals < 0 || fromDecimals > 36) {
    throw new Error("fromDecimals must be integer between 0 and 36");
  }
  if (!Number.isInteger(toDecimals) || toDecimals < 0 || toDecimals > 36) {
    throw new Error("toDecimals must be integer between 0 and 36");
  }
  const amount = parseUnsignedIntegerString(amountBaseUnitsString, "amount");
  if (fromDecimals === toDecimals) return { value: amount.toString(), exact: true };
  if (fromDecimals < toDecimals) {
    const factor = 10n ** BigInt(toDecimals - fromDecimals);
    return { value: (amount * factor).toString(), exact: true };
  }
  const factor = 10n ** BigInt(fromDecimals - toDecimals);
  const remainder = amount % factor;
  return { value: (amount / factor).toString(), exact: remainder === 0n };
}

/**
 * Convert the on-chain token atomic unit to the internal ledger unit. The
 * quotient is returned for matching/review display, while exact=false is a
 * hard signal that automatic recognition must not round the transfer.
 */
export function tokenAtomicToLedgerBase(tokenAmountAtomic, tokenDecimals = 18, ledgerDecimals = 6) {
  return convertBaseUnitsBetweenDecimals(tokenAmountAtomic, tokenDecimals, ledgerDecimals);
}

/** Convert an internal ledger amount to the on-chain token atomic unit. */
export function ledgerBaseToTokenAtomic(ledgerAmountBase, ledgerDecimals = 6, tokenDecimals = 18) {
  return convertBaseUnitsBetweenDecimals(ledgerAmountBase, ledgerDecimals, tokenDecimals);
}

/**
 * Build the three amount representations used by invoice/payment boundaries.
 * `display_amount` is derived from the ledger value unless explicitly passed.
 */
export function buildAmountSnapshot({
  tokenAmountAtomic,
  ledgerAmountBase,
  displayAmount,
  tokenDecimals = 18,
  ledgerDecimals = 6,
} = {}) {
  const token = tokenAmountAtomic == null
    ? null
    : parseUnsignedIntegerString(tokenAmountAtomic, "token_amount_atomic").toString();
  const ledger = ledgerAmountBase == null
    ? null
    : parseUnsignedIntegerString(ledgerAmountBase, "ledger_amount_base").toString();
  if (token == null && ledger == null) {
    throw new Error("token_amount_atomic or ledger_amount_base is required");
  }
  let normalizedToken = token;
  let normalizedLedger = ledger;
  if (normalizedLedger == null) {
    const converted = tokenAtomicToLedgerBase(normalizedToken, tokenDecimals, ledgerDecimals);
    normalizedLedger = converted.value;
  }
  if (normalizedToken == null) {
    normalizedToken = ledgerBaseToTokenAtomic(normalizedLedger, ledgerDecimals, tokenDecimals).value;
  }
  const normalizedDisplay = displayAmount == null
    ? formatBaseUnitsForDisplay(normalizedLedger, ledgerDecimals)
    : String(displayAmount);
  return {
    token_amount_atomic: normalizedToken,
    ledger_amount_base: normalizedLedger,
    display_amount: normalizedDisplay,
    token_decimals: Number(tokenDecimals),
    ledger_decimals: Number(ledgerDecimals),
    amount_scale_version: Number(tokenDecimals) === TOKEN_DECIMALS && Number(ledgerDecimals) === LEDGER_DECIMALS
      ? AMOUNT_SCALE_VERSION
      : `token-${Number(tokenDecimals)}-ledger-${Number(ledgerDecimals)}-v1`,
  };
}

function normalizeUnsignedAmount(value, label) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be an unsigned integer string`);
  return BigInt(raw).toString();
}

export function tokenAmountAtomicFromLedgerBase(
  ledgerAmountBase,
  tokenDecimals = TOKEN_DECIMALS,
  ledgerDecimals = LEDGER_DECIMALS,
) {
  const normalized = normalizeUnsignedAmount(ledgerAmountBase, "ledger_amount_base");
  return convertBaseUnitsBetweenDecimals(normalized, ledgerDecimals, tokenDecimals).value;
}

export function ledgerAmountBaseFromTokenAtomic(
  tokenAmountAtomic,
  tokenDecimals = TOKEN_DECIMALS,
  ledgerDecimals = LEDGER_DECIMALS,
) {
  const normalized = normalizeUnsignedAmount(tokenAmountAtomic, "token_amount_atomic");
  return convertBaseUnitsBetweenDecimals(normalized, tokenDecimals, ledgerDecimals);
}

export function requireExactLedgerAmountBaseFromTokenAtomic(
  tokenAmountAtomic,
  tokenDecimals = TOKEN_DECIMALS,
  ledgerDecimals = LEDGER_DECIMALS,
) {
  const converted = ledgerAmountBaseFromTokenAtomic(tokenAmountAtomic, tokenDecimals, ledgerDecimals);
  if (!converted.exact) {
    const error = new Error("token_amount_atomic cannot be represented exactly in ledger_amount_base");
    error.code = "NON_EXACT_TOKEN_TO_LEDGER";
    error.value = converted.value;
    return { error: error.code, value: converted.value };
  }
  return { value: converted.value };
}

export function requireExactTokenAmountAtomicFromLedgerBase(ledgerAmountBase) {
  return { value: tokenAmountAtomicFromLedgerBase(ledgerAmountBase) };
}

export function isUnsignedIntegerString(value) {
  return /^\d+$/.test(String(value ?? "").trim());
}
