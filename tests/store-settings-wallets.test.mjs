import test from "node:test";
import assert from "node:assert/strict";
import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  loginAs,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();

test("store settings reflect configured supported wallets and wallet adapter", async (t) => {
  const env = baseServerEnv({
    WALLET_ADAPTER_TYPE: "wallet_deeplink",
    WALLET_DEEPLINK_TEMPLATE: "wallet://pay?uri={{payment_uri_encoded}}",
    SUPPORTED_WALLETS: "HashPort Wallet,WalletConnect,Injected Wallet",
  });
  const started = await startServerProcess(CWD, env);

  t.after(async () => {
    await stopServerProcess(started.proc);
  });

  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });

  const settings = await apiRequest(started.baseUrl, `/api/v1/stores/${encodeURIComponent(admin.storeId)}/settings`, {
    headers: authHeaders(admin.token),
  });

  assert.equal(settings.status, 200);
  assert.deepEqual(settings.data.supported_wallets, ["HashPort Wallet", "WalletConnect", "Injected Wallet"]);
  assert.equal(settings.data.wallet_adapter?.status, "ready");
});
