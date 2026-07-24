import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  const template = "wallet://pay?uri={{payment_uri_encoded}}";
  const registry = JSON.stringify([{
    adapter_id: "hashport-jpyc-v1",
    wallet_name: "HashPort Wallet",
    allowed_scheme: "wallet",
    allowed_https_hosts: [],
    template,
    template_sha256: createHash("sha256").update(template, "utf8").digest("hex"),
    approved_at: "2026-07-25T00:00:00.000Z",
    approval_ref: "WALLET-APPROVAL-2026-001",
    tested_ios_versions: ["18.5"],
    tested_android_versions: [],
    tested_wallet_versions: ["1.0.0"],
    revoked_at: null,
  }]);
  const env = baseServerEnv({
    WALLET_ADAPTER_TYPE: "wallet_deeplink",
    WALLET_DEEPLINK_TEMPLATE: template,
    WALLET_ADAPTER_REGISTRY_JSON: registry,
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
  assert.deepEqual(settings.data.supported_wallets, [
    "検証済み環境（iOS 18.5 / ウォレット 1.0.0）: HashPort Wallet",
    "未検証: WalletConnect",
    "未検証: Injected Wallet",
  ]);
  assert.equal(settings.data.wallet_adapter?.status, "ready");
  assert.deepEqual(settings.data.wallet_adapter?.tested_environments, {
    ios_versions: ["18.5"],
    android_versions: [],
    wallet_versions: ["1.0.0"],
  });
});
