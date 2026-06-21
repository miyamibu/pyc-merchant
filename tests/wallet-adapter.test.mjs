import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEip681PaymentUri,
  buildWalletLaunchPayload,
  classifyWalletError,
  createWalletAdapter,
} from "../src/wallet-adapter.mjs";

test("mock adapter is unavailable for real transfer", () => {
  const adapter = createWalletAdapter({ WALLET_ADAPTER_TYPE: "mock" });
  assert.equal(adapter.available, false);
  assert.equal(adapter.status, "mock_only");
});

test("reown adapter requires feature flag and project id", () => {
  const disabled = createWalletAdapter({ WALLET_ADAPTER_TYPE: "reown", ENABLE_REOWN: "false", REOWN_PROJECT_ID: "pid" });
  assert.equal(disabled.available, false);
  assert.equal(disabled.status, "disabled_by_flag");

  const missingId = createWalletAdapter({ WALLET_ADAPTER_TYPE: "reown", ENABLE_REOWN: "true", REOWN_PROJECT_ID: "" });
  assert.equal(missingId.available, false);
  assert.equal(missingId.status, "missing_project_id");

  const enabled = createWalletAdapter({
    WALLET_ADAPTER_TYPE: "reown",
    ENABLE_REOWN: "true",
    REOWN_PROJECT_ID: "real-project-id",
    WALLETCONNECT_TRANSACTION_SESSION_IMPLEMENTED: "true",
  });
  assert.equal(enabled.available, true);
  assert.equal(enabled.status, "ready");

  const falseReady = createWalletAdapter({ WALLET_ADAPTER_TYPE: "reown", ENABLE_REOWN: "true", REOWN_PROJECT_ID: "real-project-id" });
  assert.equal(falseReady.available, false);
  assert.equal(falseReady.status, "transaction_session_not_implemented");
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
  const payload = buildWalletLaunchPayload({
    env: {
      WALLET_ADAPTER_TYPE: "reown",
      ENABLE_REOWN: "true",
      REOWN_PROJECT_ID: "real-project-id",
      WALLETCONNECT_TRANSACTION_SESSION_IMPLEMENTED: "true",
      WALLET_HELP_URL: "https://wallet.example/help",
      WALLET_DEEPLINK_TEMPLATE: "hashport://pay?uri={{payment_uri_encoded}}&chain={{chain_id}}&token={{token_symbol_encoded}}",
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
  assert.match(payload.payment_uri, /@137\/transfer\?/);
  assert.match(payload.payment_uri, /0x1111111111111111111111111111111111111111/);
  assert.match(payload.payment_uri, /address=0x2222222222222222222222222222222222222222/);
  assert.match(payload.payment_uri, /uint256=999000000/);
  assert.equal(
    payload.wallet_deeplink,
    `hashport://pay?uri=${encodeURIComponent(payload.payment_uri)}&chain=137&token=JPYC`
  );
  assert.deepEqual(payload.supported_wallets, ["HashPort Wallet", "WalletConnect"]);
  assert.equal(payload.copy_fallback.copy_receive_address, "0x2222222222222222222222222222222222222222");
  assert.equal(payload.copy_fallback.copy_amount, "999000000");
  assert.equal(payload.copy_fallback.copy_network, "Polygon");
  assert.equal(payload.copy_fallback.copy_token, "JPYC");
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
  assert.equal(payload.wallet_url, payload.payment_uri);
  assert.equal(payload.wallet_help_url, "https://walletconnect.com/");
  assert.equal(payload.wallet_adapter.status, "mock_only");
});

test("supported wallet display excludes WalletConnect when transaction session is not implemented", () => {
  const payload = buildWalletLaunchPayload({
    env: {
      WALLET_ADAPTER_TYPE: "reown",
      ENABLE_REOWN: "true",
      REOWN_PROJECT_ID: "real-project-id",
      SUPPORTED_WALLETS: "HashPort Wallet,WalletConnect,Injected Wallet",
    },
    chainId: "137",
    network: "Polygon",
    tokenSymbol: "JPYC",
    tokenContract: "0x1111111111111111111111111111111111111111",
    tokenDecimals: 18,
    receiveAddress: "0x2222222222222222222222222222222222222222",
    expectedAmountAtomic: "500000000000000000000",
  });

  assert.equal(payload.wallet_adapter.status, "transaction_session_not_implemented");
  assert.deepEqual(payload.supported_wallets, ["HashPort Wallet", "Injected Wallet"]);
});
