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
  const a = BigInt(String(left ?? "0"));
  const b = BigInt(String(right ?? "0"));
  if (a === b) return 0;
  return a > b ? 1 : -1;
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
  const amount = BigInt(String(amountBaseUnitsString ?? "0"));
  if (amount < 0n) throw new Error("amount must be non-negative");
  if (fromDecimals === toDecimals) return { value: amount.toString(), exact: true };
  if (fromDecimals < toDecimals) {
    const factor = 10n ** BigInt(toDecimals - fromDecimals);
    return { value: (amount * factor).toString(), exact: true };
  }
  const factor = 10n ** BigInt(fromDecimals - toDecimals);
  const remainder = amount % factor;
  return { value: (amount / factor).toString(), exact: remainder === 0n };
}
