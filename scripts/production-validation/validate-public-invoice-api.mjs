import assert from "node:assert/strict";
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

  const created = await createInvoice(started.baseUrl, token, 2300, `validation-public-${Date.now()}`);
  const signed = parsePaymentUrl(created.payment_url);
  const publicInvoicePath = `/api/v1/public/invoices/${encodeURIComponent(signed.invoiceId)}?sig=${encodeURIComponent(signed.sig)}&exp=${encodeURIComponent(signed.exp)}&nonce=${encodeURIComponent(signed.nonce)}`;
  const publicInvoice = await apiRequest(started.baseUrl, publicInvoicePath);
  assert.equal(publicInvoice.status, 200);
  assert.equal(publicInvoice.data.chain_id, "137");
  assert.equal(publicInvoice.data.network, "Polygon");
  assert.equal(publicInvoice.data.token_symbol, "JPYC");
  assert.equal(Number(publicInvoice.data.token_decimals), 18);
  assert.equal(publicInvoice.data.receive_address.toLowerCase(), env.RECIPIENT_ADDRESS.toLowerCase());
  assert.equal(publicInvoice.data.pay_url, created.payment_url);
  assert.equal(publicInvoice.data.copy_fallback.copy_network, "Polygon");
  assert.equal(publicInvoice.data.copy_fallback.copy_token, "JPYC");
  assert.match(publicInvoice.data.payment_uri, /ethereum:/);
  assert.match(publicInvoice.data.payment_uri, /@137\/transfer\?/);
  assert.match(publicInvoice.data.payment_uri, /uint256=2300000000000000000000/);
  assert.equal(publicInvoice.data.expected_amount_atomic, "2300000000000000000000");

  const payRedirect = await fetch(created.payment_url, { redirect: "manual" });
  assert.equal(payRedirect.status, 302);
  assert.match(String(payRedirect.headers.get("location") || ""), /^\/mobile\.html\?/);

  const expireRes = await apiRequest(
    started.baseUrl,
    `/api/v1/invoices/${encodeURIComponent(created.invoice_id)}/expire`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": `validation-expire-${Date.now()}`,
      },
      body: "{}",
    }
  );
  assert.equal(expireRes.status, 200);

  const expiredInvoice = await apiRequest(started.baseUrl, publicInvoicePath);
  assert.equal(expiredInvoice.status, 200);
  assert.equal(expiredInvoice.data.status, "expired");

  console.log(
    JSON.stringify(
      {
        status: "pass",
        checks: {
          invoice_create_status: 201,
          public_invoice_status: publicInvoice.status,
          pay_redirect_status: payRedirect.status,
          expired_invoice_status: expiredInvoice.data.status,
          payment_uri: publicInvoice.data.payment_uri,
        },
      },
      null,
      2
    )
  );
} finally {
  await stopValidationServer(started.proc);
}
