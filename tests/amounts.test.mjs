import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAmountSnapshot,
  compareBaseUnits,
  convertBaseUnitsBetweenDecimals,
  formatBaseUnitsForDisplay,
  ledgerBaseToTokenAtomic,
  parseDecimalToBaseUnits,
  parseUnsignedIntegerString,
  scaleToDecimals,
  tokenAtomicToLedgerBase,
} from "../src/amounts.mjs";

test("scaleToDecimals: power-of-10 scale", () => {
  assert.equal(scaleToDecimals("1000000"), 6);
  assert.equal(scaleToDecimals("1"), 0);
});

test("parseDecimalToBaseUnits: exact conversion", () => {
  assert.equal(parseDecimalToBaseUnits("12.34", 2), "1234");
  assert.equal(parseDecimalToBaseUnits("0.000001", 6), "1");
});

test("parseDecimalToBaseUnits: rejects silent rounding", () => {
  assert.throws(() => parseDecimalToBaseUnits("0.0000001", 6), /too many decimal places/);
});

test("formatBaseUnitsForDisplay: trims trailing zeros", () => {
  assert.equal(formatBaseUnitsForDisplay("1000000", 6), "1");
  assert.equal(formatBaseUnitsForDisplay("1234500", 6), "1.2345");
});

test("compareBaseUnits: bigint-safe compare", () => {
  assert.equal(compareBaseUnits("9007199254740993", "9007199254740992"), 1);
  assert.equal(compareBaseUnits("42", "42"), 0);
  assert.equal(compareBaseUnits("1", "9"), -1);
});

test("convertBaseUnitsBetweenDecimals: preserves exactness", () => {
  assert.deepEqual(convertBaseUnitsBetweenDecimals("1234500000000000000", 18, 6), {
    value: "1234500",
    exact: true,
  });
  assert.deepEqual(convertBaseUnitsBetweenDecimals("1234501", 6, 18), {
    value: "1234501000000000000",
    exact: true,
  });
  assert.deepEqual(convertBaseUnitsBetweenDecimals("19", 1, 0), {
    value: "1",
    exact: false,
  });
});

test("token atomic amount remains a decimal string beyond Number.MAX_SAFE_INTEGER", () => {
  const atomic = ledgerBaseToTokenAtomic("1000000000", 6, 18);
  assert.equal(atomic.value, "1000000000000000000000");
  assert.equal(typeof atomic.value, "string");
  assert.equal(parseUnsignedIntegerString(atomic.value, "token_amount_atomic").toString(), atomic.value);
});

test("18-to-6 conversion never rounds a non-exact token transfer", () => {
  assert.deepEqual(tokenAtomicToLedgerBase("1000000000000000000001", 18, 6), {
    value: "1000000000",
    exact: false,
  });
});

test("amount snapshot keeps token, ledger, and display representations separate", () => {
  assert.deepEqual(buildAmountSnapshot({ ledgerAmountBase: "1000000000" }), {
    token_amount_atomic: "1000000000000000000000",
    ledger_amount_base: "1000000000",
    display_amount: "1000",
    token_decimals: 18,
    ledger_decimals: 6,
    amount_scale_version: "token-18-ledger-6-v1",
  });
});
