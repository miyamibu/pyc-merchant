import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildEip681PaymentUri,
  buildWalletLaunchPayload,
  classifyWalletError,
  createWalletAdapter,
} from "../src/wallet-adapter.mjs";

function approvedRegistry(template, options = {}) {
  const walletName = options.walletName || "HashPort Wallet";
  const allowedScheme = options.allowedScheme || new URL(template.replace(/\{\{[^}]+\}\}/g, "sample")).protocol.replace(":", "");
  return JSON.stringify([{
    adapter_id: options.adapterId || "hashport-jpyc-v1",
    wallet_name: walletName,
    allowed_scheme: allowedScheme,
    allowed_https_hosts: options.allowedHttpsHosts || [],
    template,
    template_sha256: createHash("sha256").update(template, "utf8").digest("hex"),
    approved_at: "2026-07-25T00:00:00.000Z",
    approval_ref: "WALLET-APPROVAL-2026-001",
    tested_ios_versions: options.tested === false ? [] : ["18.5"],
    tested_android_versions: [],
    tested_wallet_versions: options.tested === false ? [] : ["1.0.0"],
    revoked_at: null,
  }]);
}

test("mock adapter is unavailable for real transfer", () => {
  const adapter = createWalletAdapter({ WALLET_ADAPTER_TYPE: "mock" });
  assert.equal(adapter.available, false);
  assert.equal(adapter.status, "mock_only");
});

test("Reown is not advertised until a real session integration exists", () => {
  const reown = createWalletAdapter({ WALLET_ADAPTER_TYPE: "reown", ENABLE_REOWN: "true", REOWN_PROJECT_ID: "real-project-id" });
  assert.equal(reown.available, false);
  assert.equal(reown.status, "reown_session_not_implemented");
});

test("configured wallet deeplink adapter requires a reviewed template and approved registry", () => {
  const missingTemplate = createWalletAdapter({ WALLET_ADAPTER_TYPE: "wallet_deeplink" });
  assert.equal(missingTemplate.available, false);
  assert.equal(missingTemplate.status, "missing_deeplink_template");

  const template = "wallet://pay?uri={{payment_uri_encoded}}";
  const missingRegistry = createWalletAdapter({
    WALLET_ADAPTER_TYPE: "wallet_deeplink",
    WALLET_DEEPLINK_TEMPLATE: template,
  });
  assert.equal(missingRegistry.available, false);
  assert.equal(missingRegistry.status, "missing_approved_adapter_registry");

  const enabled = createWalletAdapter({
    WALLET_ADAPTER_TYPE: "wallet_deeplink",
    WALLET_DEEPLINK_TEMPLATE: template,
    WALLET_ADAPTER_REGISTRY_JSON: approvedRegistry(template),
  });
  assert.equal(enabled.available, true);
  assert.equal(enabled.status, "ready");
  assert.equal(enabled.capability_level, "environment_scoped_tested");
  assert.deepEqual(enabled.tested_environments, {
    ios_versions: ["18.5"],
    android_versions: [],
    wallet_versions: ["1.0.0"],
  });
});

test("wallet registry rejects unknown placeholders, hash drift, and credentials", () => {
  const unknownTemplate = "wallet://pay?uri={{unknown_value}}";
  const unknown = createWalletAdapter({
    WALLET_ADAPTER_TYPE: "wallet_deeplink",
    WALLET_DEEPLINK_TEMPLATE: unknownTemplate,
    WALLET_ADAPTER_REGISTRY_JSON: approvedRegistry(unknownTemplate),
  });
  assert.equal(unknown.available, false);
  assert.equal(unknown.status, "template_placeholder_invalid");

  const validTemplate = "wallet://pay?uri={{payment_uri_encoded}}";
  const hashDrift = JSON.parse(approvedRegistry(validTemplate));
  hashDrift[0].template_sha256 = "0".repeat(64);
  const invalidHash = createWalletAdapter({
    WALLET_ADAPTER_TYPE: "wallet_deeplink",
    WALLET_DEEPLINK_TEMPLATE: validTemplate,
    WALLET_ADAPTER_REGISTRY_JSON: JSON.stringify(hashDrift),
  });
  assert.equal(invalidHash.available, false);
  assert.equal(invalidHash.status, "registry_template_hash_mismatch");

  const credentialTemplate = "wallet://user:secret@pay?uri={{payment_uri_encoded}}";
  const credentialed = createWalletAdapter({
    WALLET_ADAPTER_TYPE: "wallet_deeplink",
    WALLET_DEEPLINK_TEMPLATE: credentialTemplate,
    WALLET_ADAPTER_REGISTRY_JSON: approvedRegistry(credentialTemplate),
  });
  assert.equal(credentialed.available, false);
  assert.equal(credentialed.status, "template_credentials_not_allowed");
});

test("wallet error classification keeps known categories", () => {
  assert.equal(classifyWalletError("insufficient_funds"), "balance_insufficient");
  assert.equal(classifyWalletError("gas_too_low"), "gas_insufficient");
  assert.equal(classifyWalletError("wrong_chain"), "wrong_chain");
  assert.equal(classifyWalletError("signature_rejected"), "signature_rejected");
  assert.equal(classifyWalletError("tx_pending"), "tx_pending");
  assert.equal(classifyWalletError("something_else"), "unknown");
});

test("buildEip681PaymentUri returns Polygon ERC-20 transfer URI", () => {
  const uri = buildEip681PaymentUri({
    chainId: "137",
    tokenContract: "0x1111111111111111111111111111111111111111",
    receiveAddress: "0x2222222222222222222222222222222222222222",
    expectedAmountAtomic: "1200000000",
  });
  assert.equal(
    uri,
    "ethereum:0x1111111111111111111111111111111111111111@137/transfer?address=0x2222222222222222222222222222222222222222&uint256=1200000000"
  );
});

test("buildWalletLaunchPayload expands deeplink template and preserves copy fallback", () => {
  const template = "hashport://pay?uri={{payment_uri_encoded}}&chain={{chain_id}}&token={{token_symbol_encoded}}";
  const payload = buildWalletLaunchPayload({
    env: {
      WALLET_ADAPTER_TYPE: "wallet_deeplink",
      WALLET_HELP_URL: "https://wallet.example/help",
      WALLET_DEEPLINK_TEMPLATE: template,
      WALLET_ADAPTER_REGISTRY_JSON: approvedRegistry(template, { allowedScheme: "hashport" }),
      SUPPORTED_WALLETS: "HashPort Wallet,WalletConnect",
    },
    chainId: "137",
    network: "Polygon",
    tokenSymbol: "JPYC",
    tokenContract: "0x1111111111111111111111111111111111111111",
    tokenDecimals: 6,
    receiveAddress: "0x2222222222222222222222222222222222222222",
    expectedAmountAtomic: "999000000",
    amountJpy: 999,
    expiresAt: "2026-04-20T12:00:00.000Z",
    payUrl: "https://terminal.example.com/pay?ref=test",
  });

  assert.equal(payload.wallet_adapter.available, true);
  assert.equal(payload.wallet_adapter.expanded_target_validated, true);
  assert.match(payload.payment_uri, /@137\/transfer\?/);
  assert.match(payload.payment_uri, /0x1111111111111111111111111111111111111111/);
  assert.match(payload.payment_uri, /address=0x2222222222222222222222222222222222222222/);
  assert.match(payload.payment_uri, /uint256=999000000/);
  assert.equal(
    payload.wallet_deeplink,
    `hashport://pay?uri=${encodeURIComponent(payload.payment_uri)}&chain=137&token=JPYC`
  );
  assert.deepEqual(payload.supported_wallets, [
    "検証済み環境（iOS 18.5 / ウォレット 1.0.0）: HashPort Wallet",
    "未検証: WalletConnect",
  ]);
  assert.doesNotMatch(payload.supported_wallets.join("\n"), /^実機検証済み:/m);
  assert.equal(payload.copy_fallback.copy_receive_address, "0x2222222222222222222222222222222222222222");
  assert.equal(payload.copy_fallback.copy_amount, "999000000");
  assert.equal(payload.copy_fallback.copy_network, "Polygon");
  assert.equal(payload.copy_fallback.copy_token, "JPYC");
});

test("wallet capability labels fail closed when OS or wallet version evidence is missing", () => {
  const template = "wallet://pay?uri={{payment_uri_encoded}}";
  const payload = buildWalletLaunchPayload({
    env: {
      WALLET_ADAPTER_TYPE: "wallet_deeplink",
      WALLET_DEEPLINK_TEMPLATE: template,
      WALLET_ADAPTER_REGISTRY_JSON: approvedRegistry(template, { tested: false }),
      SUPPORTED_WALLETS: "HashPort Wallet",
    },
    chainId: "137",
    network: "Polygon",
    tokenSymbol: "JPYC",
    tokenContract: "0x1111111111111111111111111111111111111111",
    tokenDecimals: 6,
    receiveAddress: "0x2222222222222222222222222222222222222222",
    expectedAmountAtomic: "500000000",
  });

  assert.equal(payload.wallet_adapter.capability_level, "launch");
  assert.deepEqual(payload.supported_wallets, [
    "起動導線あり（OS・ウォレット版は未検証）: HashPort Wallet",
  ]);
  assert.doesNotMatch(payload.supported_wallets.join("\n"), /実機検証済み/);
});

test("actual wallet target expansion is revalidated and fails closed for invalid payment values", () => {
  const template = "wallet://pay?uri={{payment_uri_encoded}}";
  const payload = buildWalletLaunchPayload({
    env: {
      WALLET_ADAPTER_TYPE: "wallet_deeplink",
      WALLET_DEEPLINK_TEMPLATE: template,
      WALLET_ADAPTER_REGISTRY_JSON: approvedRegistry(template),
    },
    chainId: "137",
    network: "Polygon",
    tokenSymbol: "JPYC",
    tokenContract: "not-an-evm-address",
    tokenDecimals: 6,
    receiveAddress: "0x2222222222222222222222222222222222222222",
    expectedAmountAtomic: "500000000",
  });

  assert.equal(payload.payment_uri, null);
  assert.equal(payload.wallet_deeplink, null);
  assert.equal(payload.wallet_url, null);
  assert.equal(payload.wallet_adapter.available, false);
  assert.equal(payload.wallet_adapter.status, "payment_payload_invalid");
  assert.equal(payload.wallet_adapter.expanded_target_validated, false);
});

test("wallet template cannot satisfy transfer validation with values hidden in a fragment", () => {
  const attackerAddress = "0x3333333333333333333333333333333333333333";
  const template = `wallet://pay?recipient=${attackerAddress}&amount=1&chain=1&token=${attackerAddress}#{{receive_address}}|{{expected_amount_atomic}}|{{chain_id}}|{{token_contract}}`;
  const payload = buildWalletLaunchPayload({
    env: {
      WALLET_ADAPTER_TYPE: "wallet_deeplink",
      WALLET_DEEPLINK_TEMPLATE: template,
      WALLET_ADAPTER_REGISTRY_JSON: approvedRegistry(template),
    },
    chainId: "137",
    network: "Polygon",
    tokenSymbol: "JPYC",
    tokenContract: "0x1111111111111111111111111111111111111111",
    tokenDecimals: 6,
    receiveAddress: "0x2222222222222222222222222222222222222222",
    expectedAmountAtomic: "500000000",
  });

  assert.equal(payload.wallet_deeplink, null);
  assert.equal(payload.wallet_url, null);
  assert.equal(payload.wallet_adapter.available, false);
  assert.equal(payload.wallet_adapter.status, "template_fragment_not_allowed");
  assert.equal(payload.wallet_adapter.expanded_target_validated, false);
});

test("wallet template rejects static transfer overrides beside a valid payment URI", () => {
  const attackerAddress = "0x3333333333333333333333333333333333333333";
  const template = `wallet://pay?recipient=${attackerAddress}&amount=1&chain=1&token=${attackerAddress}&uri={{payment_uri_encoded}}`;
  const adapter = createWalletAdapter({
    WALLET_ADAPTER_TYPE: "wallet_deeplink",
    WALLET_DEEPLINK_TEMPLATE: template,
    WALLET_ADAPTER_REGISTRY_JSON: approvedRegistry(template),
  });

  assert.equal(adapter.available, false);
  assert.equal(adapter.status, "template_unbound_parameter_not_allowed");
});

test("actual wallet target values must remain bound to their reviewed query parameters", () => {
  const template = "wallet://pay?uri={{payment_uri_encoded}}&token={{token_symbol}}";
  const payload = buildWalletLaunchPayload({
    env: {
      WALLET_ADAPTER_TYPE: "wallet_deeplink",
      WALLET_DEEPLINK_TEMPLATE: template,
      WALLET_ADAPTER_REGISTRY_JSON: approvedRegistry(template),
    },
    chainId: "137",
    network: "Polygon",
    tokenSymbol: "JPYC&recipient=0x3333333333333333333333333333333333333333",
    tokenContract: "0x1111111111111111111111111111111111111111",
    tokenDecimals: 6,
    receiveAddress: "0x2222222222222222222222222222222222222222",
    expectedAmountAtomic: "500000000",
  });

  assert.equal(payload.wallet_deeplink, null);
  assert.equal(payload.wallet_url, null);
  assert.equal(payload.wallet_adapter.available, false);
  assert.equal(payload.wallet_adapter.status, "expanded_target_binding_value_mismatch");
  assert.equal(payload.wallet_adapter.expanded_target_validated, false);
});

test("blocked protocols stay blocked even when a registry entry allowlists them", () => {
  // data:, file:, http:, and javascript: are hard-blocked at the module level.
  // A reviewed registry entry must not be able to re-enable them, so an
  // operator mistake in allowed_scheme can never widen the launch surface.
  for (const template of [
    "http://pay.example/wallet?uri={{payment_uri_encoded}}",
    "javascript://pay?uri={{payment_uri_encoded}}",
    "data:text/html?uri={{payment_uri_encoded}}",
    "file:///wallet?uri={{payment_uri_encoded}}",
  ]) {
    const adapter = createWalletAdapter({
      WALLET_ADAPTER_TYPE: "wallet_deeplink",
      WALLET_DEEPLINK_TEMPLATE: template,
      WALLET_ADAPTER_REGISTRY_JSON: approvedRegistry(template),
    });
    assert.equal(adapter.available, false, template);
    assert.equal(adapter.status, "template_scheme_not_allowed", template);
  }
});

test("non-wallet action schemes stay blocked even when a registry entry allowlists them", () => {
  // Communication, package-market, and Android intent schemes are never
  // wallet launch targets. A reviewed registry entry cannot re-enable them.
  for (const template of [
    "mailto:pay@example.com?uri={{payment_uri_encoded}}",
    "tel:000?uri={{payment_uri_encoded}}",
    "sms:000?uri={{payment_uri_encoded}}",
    "intent://pay?uri={{payment_uri_encoded}}",
    "market://details?uri={{payment_uri_encoded}}",
  ]) {
    const adapter = createWalletAdapter({
      WALLET_ADAPTER_TYPE: "wallet_deeplink",
      WALLET_DEEPLINK_TEMPLATE: template,
      WALLET_ADAPTER_REGISTRY_JSON: approvedRegistry(template),
    });
    assert.equal(adapter.available, false, template);
    assert.equal(adapter.status, "template_scheme_not_allowed", template);
  }
});

test("buildWalletLaunchPayload falls back to payment URI without deeplink template", () => {
  const payload = buildWalletLaunchPayload({
    env: {
      WALLET_ADAPTER_TYPE: "mock",
      WALLET_HELP_URL: "https://walletconnect.com/",
    },
    chainId: "137",
    network: "Polygon",
    tokenSymbol: "JPYC",
    tokenContract: "0x1111111111111111111111111111111111111111",
    tokenDecimals: 6,
    receiveAddress: "0x2222222222222222222222222222222222222222",
    expectedAmountAtomic: "500000000",
    amountJpy: 500,
    expiresAt: "2026-04-20T12:00:00.000Z",
    payUrl: "https://terminal.example.com/pay?ref=test",
  });

  assert.equal(payload.wallet_deeplink, null);
  assert.equal(payload.wallet_url, null);
  assert.equal(payload.wallet_help_url, "https://walletconnect.com/");
  assert.equal(payload.wallet_adapter.status, "mock_only");
});
