import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  apiRequest,
  createInvoice,
  createValidationEnv,
  loginAs,
  parsePaymentUrl,
  startValidationServer,
  stopValidationServer,
} from "./lib.mjs";

const cwd = process.cwd();
const env = createValidationEnv();
const started = await startValidationServer(cwd, env);

try {
  const token = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
  });

  const created = await createInvoice(started.baseUrl, token, 1200, `validation-wallet-${Date.now()}`);
  const signed = parsePaymentUrl(created.payment_url);
  const publicInvoice = await apiRequest(
    started.baseUrl,
    `/api/v1/public/invoices/${encodeURIComponent(signed.invoiceId)}?sig=${encodeURIComponent(signed.sig)}&exp=${encodeURIComponent(signed.exp)}&nonce=${encodeURIComponent(signed.nonce)}`
  );

  assert.equal(publicInvoice.status, 200);
  assert.equal(publicInvoice.data.wallet_adapter.available, true);
  assert.equal(publicInvoice.data.wallet_adapter.status, "ready");
  assert.match(publicInvoice.data.payment_uri, /^ethereum:/);
  assert.equal(
    publicInvoice.data.wallet_deeplink,
    `hashport://pay?uri=${encodeURIComponent(publicInvoice.data.payment_uri)}`
  );
  assert.equal(publicInvoice.data.wallet_url, publicInvoice.data.wallet_deeplink);

  const mobileHtml = fs.readFileSync(path.join(cwd, "public/mobile.html"), "utf8");
  assert.match(mobileHtml, /ウォレットで支払う/);
  assert.match(mobileHtml, /手動送金を表示/);
  assert.match(mobileHtml, /支払い情報をコピー/);
  assert.match(mobileHtml, /支払いネットワーク/);
  assert.match(mobileHtml, /支払い先/);

  const mobileJs = fs.readFileSync(path.join(cwd, "public/mobile.js"), "utf8");
  assert.match(mobileJs, /wallet_deeplink/);
  assert.match(mobileJs, /payment_uri/);
  assert.match(mobileJs, /wallet_url/);
  assert.match(mobileJs, /buildManualPaymentInstructions/);

  console.log(
    JSON.stringify(
      {
        status: "pass",
        checks: {
          payment_uri: publicInvoice.data.payment_uri,
          wallet_deeplink: publicInvoice.data.wallet_deeplink,
          wallet_url: publicInvoice.data.wallet_url,
          copy_fallback: publicInvoice.data.copy_fallback,
        },
        external_pending: [
          {
            id: "REAL_DEVICE_HASHPORT",
            reason: "実機の HashPort Wallet / iOS / Android 送金画面起動はローカルCI環境では実行できない",
          },
        ],
      },
      null,
      2
    )
  );
} finally {
  await stopValidationServer(started.proc);
}
