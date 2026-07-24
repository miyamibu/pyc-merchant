import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  createInvoice,
  getInvoice,
  loginAs,
  parsePaymentUrl,
  randomTxHash,
  startServerProcess,
  stopServerProcess,
} from "../tests/helpers/server-process.mjs";
import { buildServiceAuthHeaders } from "../tests/helpers/service-auth.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const runStamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const OUT_DIR = path.join(ROOT, "output", "story-api-retest", runStamp);

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function idem(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function makeAddress(suffixHex) {
  return `0x${String(suffixHex).padStart(40, "0").slice(-40)}`;
}

function summarizeBody(data) {
  if (data == null || typeof data !== "object") return data;
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) out[key] = { type: "array", length: value.length };
    else if (value && typeof value === "object") out[key] = { type: "object", keys: Object.keys(value).slice(0, 12) };
    else out[key] = value;
  }
  return out;
}

async function run() {
  await ensureDir(OUT_DIR);
  const env = baseServerEnv({
    ALLOW_MANUAL_PAYMENT_INGEST: "true",
    SETTLEMENT_BLOCK_ON_UNRESOLVED_REVIEWS: "true",
    SETTLEMENT_UNRESOLVED_REVIEW_POLICY: "block",
    WALLET_ADAPTER_TYPE: "mock",
    ENABLE_REOWN: "false",
    ENABLE_PROVIDER_RAIL_MOCK: "true",
  });
  env.CORS_ALLOW_ORIGINS = [env.APP_HOST, "http://127.0.0.1:4173"].join(",");

  const assertions = [];
  const evidence = [];
  let started = null;

  const record = (storyIds, name, result, details = {}) => {
    assertions.push({ story_ids: storyIds, name, result, ...details });
  };

  const request = async (name, storyIds, pathName, options = {}, expectedStatuses = [200]) => {
    const res = await apiRequest(started.baseUrl, pathName, options);
    const ok = expectedStatuses.includes(res.status);
    evidence.push({
      name,
      story_ids: storyIds,
      method: options.method || "GET",
      path: pathName,
      status: res.status,
      expected_statuses: expectedStatuses,
      body_summary: summarizeBody(res.data),
    });
    if (!ok) {
      throw new Error(`${name} expected ${expectedStatuses.join("/")} but got ${res.status}: ${JSON.stringify(res.data)}`);
    }
    record(storyIds, name, "pass", { status: res.status });
    return res;
  };

  try {
    started = await startServerProcess(ROOT, env);
    const admin = await loginAs(started.baseUrl, {
      terminalCode: env.TERMINAL_CODE,
      pin: env.STAFF_PIN,
      staffName: "Demo Staff",
    });
    const approver = await loginAs(started.baseUrl, {
      terminalCode: env.TERMINAL_CODE,
      pin: env.SECOND_ADMIN_PIN,
      staffName: "Demo Approver",
    });
    const headers = (extra = {}) => authHeaders(admin.token, extra);

    await request("staff list", ["AS-001"], "/api/v1/staff", { headers: headers() });
    const createdStaff = await request(
      "staff create",
      ["AS-001"],
      "/api/v1/staff",
      {
        method: "POST",
        headers: headers({ "content-type": "application/json", "idempotency-key": idem("staff-create") }),
        body: JSON.stringify({ staff_name: "Story API Staff", role: "operator", pin: "1357", status: "active" }),
      },
      [201]
    );
    const staffId = createdStaff.data.staff.id;
    await request("staff patch", ["AS-001"], `/api/v1/staff/${encodeURIComponent(staffId)}`, {
      method: "PATCH",
      headers: headers({ "content-type": "application/json", "idempotency-key": idem("staff-patch") }),
      body: JSON.stringify({ role: "manager", status: "inactive" }),
    });
    await request("staff pin rotate", ["AS-001"], `/api/v1/staff/${encodeURIComponent(staffId)}/pin:rotate`, {
      method: "POST",
      headers: headers({ "content-type": "application/json", "idempotency-key": idem("staff-pin") }),
      body: JSON.stringify({ new_pin: "24680" }),
    });

    const terminals = await request("terminal list", ["AS-002"], "/api/v1/terminals", { headers: headers() });
    const existingTerminalId = terminals.data.terminals[0].id;
    const createdTerminal = await request(
      "terminal create",
      ["AS-002"],
      "/api/v1/terminals",
      {
        method: "POST",
        headers: headers({ "content-type": "application/json", "idempotency-key": idem("terminal-create") }),
        body: JSON.stringify({ terminal_code: `TERM-STORY-${Date.now()}`, status: "active" }),
      },
      [201]
    );
    const newTerminalId = createdTerminal.data.terminal.id;
    await request("terminal patch", ["AS-002"], `/api/v1/terminals/${encodeURIComponent(newTerminalId)}`, {
      method: "PATCH",
      headers: headers({ "content-type": "application/json", "idempotency-key": idem("terminal-patch") }),
      body: JSON.stringify({ status: "inactive" }),
    });
    await request("terminal bindings", ["AS-002"], `/api/v1/terminals/${encodeURIComponent(existingTerminalId)}/bindings`, { headers: headers() });

    const sessions = await request("session list", ["AS-003"], "/api/v1/terminal-sessions?include_ended=true&limit=20", { headers: headers() });
    const revokeCandidate = sessions.data.sessions.find((row) => row.id === approver.sessionId) || sessions.data.sessions.find((row) => row.id !== admin.sessionId);
    if (revokeCandidate) {
      await request("session revoke", ["AS-003"], `/api/v1/terminal-sessions/${encodeURIComponent(revokeCandidate.id)}/revoke`, {
        method: "POST",
        headers: headers({ "content-type": "application/json", "idempotency-key": idem("session-revoke") }),
        body: "{}",
      });
    }

    await request("payments disable global denied for store admin", ["AS-004"], "/api/v1/admin/payments/disable", {
      method: "POST",
      headers: headers({ "content-type": "application/json", "idempotency-key": idem("payments-disable") }),
      body: JSON.stringify({ reason: "story_api_retest" }),
    }, [403]);
    await request("payments enable global denied for store admin", ["AS-004"], "/api/v1/admin/payments/enable", {
      method: "POST",
      headers: headers({ "content-type": "application/json", "idempotency-key": idem("payments-enable") }),
      body: JSON.stringify({ reason: "story_api_retest" }),
    }, [403]);
    await request("payments disable terminal", ["AS-004"], `/api/v1/admin/terminals/${encodeURIComponent(existingTerminalId)}/payments/disable`, {
      method: "POST",
      headers: headers({ "content-type": "application/json", "idempotency-key": idem("terminal-disable") }),
      body: JSON.stringify({ reason: "story_api_retest" }),
    });
    await request("payments enable terminal", ["AS-004"], `/api/v1/admin/terminals/${encodeURIComponent(existingTerminalId)}/payments/enable`, {
      method: "POST",
      headers: headers({ "content-type": "application/json", "idempotency-key": idem("terminal-enable") }),
      body: JSON.stringify({ reason: "story_api_retest" }),
    });
    await request("payments disable store", ["AS-004"], `/api/v1/admin/stores/${encodeURIComponent(admin.storeId)}/payments/disable`, {
      method: "POST",
      headers: headers({ "content-type": "application/json", "idempotency-key": idem("store-disable") }),
      body: JSON.stringify({ reason: "story_api_retest" }),
    });
    await request("payments enable store", ["AS-004"], `/api/v1/admin/stores/${encodeURIComponent(admin.storeId)}/payments/enable`, {
      method: "POST",
      headers: headers({ "content-type": "application/json", "idempotency-key": idem("store-enable") }),
      body: JSON.stringify({ reason: "story_api_retest" }),
    });

    const importAddresses = ["51", "52", "53", "54", "55", "56", "57"].map(makeAddress);
    const importedAddresses = await request(
      "receive address import",
      ["AS-005"],
      "/api/v1/admin/receive-addresses:import",
      {
        method: "POST",
        headers: headers({ "content-type": "application/json", "idempotency-key": idem("address-import") }),
        body: JSON.stringify({ addresses: importAddresses, source_label: "story-api-retest" }),
      },
      [201]
    );
    await request("receive address list", ["AS-005"], "/api/v1/admin/receive-addresses", { headers: headers() });

    const invoiceForEntry = await createInvoice(started.baseUrl, admin.token, 901, idem("fixed-entry-invoice"));
    if (invoiceForEntry.status !== 201) throw new Error(`fixed entry invoice create failed ${JSON.stringify(invoiceForEntry.data)}`);
    const entryUrl = new URL(invoiceForEntry.data.fixed_qr_url);
    await request("fixed terminal entry", ["US-005"], `${entryUrl.pathname}${entryUrl.search}`, {}, [200]);
    await request("public config", ["US-007"], "/api/v1/public/config", {}, [200]);
    const signedEntryInvoice = parsePaymentUrl(invoiceForEntry.data.payment_url);
    const signedQuery = `sig=${encodeURIComponent(signedEntryInvoice.sig)}&exp=${encodeURIComponent(signedEntryInvoice.exp)}&nonce=${encodeURIComponent(signedEntryInvoice.nonce)}`;
    await request("public invoice signed read", ["US-001", "US-002", "US-007"], `/api/v1/public/invoices/${encodeURIComponent(signedEntryInvoice.invoiceId)}?${signedQuery}`, {}, [200]);
    await request("public consent fails closed before policy publication", ["US-002"], `/api/v1/public/invoices/${encodeURIComponent(signedEntryInvoice.invoiceId)}/consent?${signedQuery}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ terms_version: "story-retest", privacy_version: "story-retest", refund_policy_version: "story-retest" }),
    }, [503]);
    await request("public payment simulation expected disabled", ["US-003"], `/api/v1/public/invoices/${encodeURIComponent(signedEntryInvoice.invoiceId)}/pay?${signedQuery}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx_hash: randomTxHash("public-pay-disabled") }),
    }, [403]);
    await request("invoice sse token", ["ES-006", "AS-003"], `/api/v1/invoices/${encodeURIComponent(invoiceForEntry.data.invoice_id)}/sse-token`, {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: "{}",
    });

    await request("invoice cancel", ["ES-004"], `/api/v1/invoices/${encodeURIComponent(invoiceForEntry.data.invoice_id)}/cancel`, {
      method: "POST",
      headers: headers({ "content-type": "application/json", "idempotency-key": idem("invoice-cancel") }),
      body: "{}",
    });
    const invoiceForReissue = await createInvoice(started.baseUrl, admin.token, 902, idem("reissue-invoice"));
    if (invoiceForReissue.status !== 201) throw new Error(`reissue invoice create failed ${JSON.stringify(invoiceForReissue.data)}`);
    const reissue = await request(
      "invoice reissue",
      ["ES-004"],
      `/api/v1/invoices/${encodeURIComponent(invoiceForReissue.data.invoice_id)}/reissue`,
      {
        method: "POST",
        headers: headers({ "content-type": "application/json", "idempotency-key": idem("invoice-reissue") }),
        body: "{}",
      },
      [201]
    );
    await request("invoice expire", ["ES-004"], `/api/v1/invoices/${encodeURIComponent(reissue.data.invoice_id)}/expire`, {
      method: "POST",
      headers: headers({ "content-type": "application/json", "idempotency-key": idem("invoice-expire") }),
      body: "{}",
    });

    const providerInvoice = await createInvoice(started.baseUrl, admin.token, 903, idem("provider-invoice"));
    if (providerInvoice.status !== 201) throw new Error(`provider invoice create failed ${JSON.stringify(providerInvoice.data)}`);
    await request("provider present", ["ES-008", "AS-014"], `/api/v1/invoices/${encodeURIComponent(providerInvoice.data.invoice_id)}/provider-sessions:present`, {
      method: "POST",
      headers: headers({ "content-type": "application/json", "idempotency-key": idem("provider-present") }),
      body: "{}",
    });
    await request("provider cancel", ["ES-008", "AS-014"], `/api/v1/invoices/${encodeURIComponent(providerInvoice.data.invoice_id)}/provider-sessions:cancel`, {
      method: "POST",
      headers: headers({ "content-type": "application/json", "idempotency-key": idem("provider-cancel") }),
      body: "{}",
    });
    await request("invoice cleanup cancel after provider", ["ES-004"], `/api/v1/invoices/${encodeURIComponent(providerInvoice.data.invoice_id)}/cancel`, {
      method: "POST",
      headers: headers({ "content-type": "application/json", "idempotency-key": idem("provider-invoice-cancel") }),
      body: "{}",
    });

    const serviceInvoice = await createInvoice(started.baseUrl, admin.token, 904, idem("service-ingest-invoice"));
    if (serviceInvoice.status !== 201) throw new Error(`service invoice create failed ${JSON.stringify(serviceInvoice.data)}`);
    const servicePayload = {
      invoice_id: serviceInvoice.data.invoice_id,
      amount_jpyc: 904,
      chain_id: env.CHAIN_ID,
      token_contract: env.TOKEN_CONTRACT,
      to_address: env.RECIPIENT_ADDRESS,
      confirmations: 3,
      tx_hash: randomTxHash("service-ingest"),
      from_address: "0x7777777777777777777777777777777777777777",
    };
    const serviceIdem = idem("service-payment-ingest");
    await request("service payment ingest", ["AS-010", "US-004"], "/api/v1/internal/payments/events:ingest", {
      method: "POST",
      headers: buildServiceAuthHeaders(env, servicePayload, serviceIdem),
      body: JSON.stringify(servicePayload),
    });

    const providerEventInvoice = await createInvoice(started.baseUrl, admin.token, 905, idem("provider-event-invoice"));
    if (providerEventInvoice.status !== 201) throw new Error(`provider event invoice create failed ${JSON.stringify(providerEventInvoice.data)}`);
    const providerEventDetail = await getInvoice(started.baseUrl, admin.token, providerEventInvoice.data.invoice_id);
    if (providerEventDetail.status !== 200) throw new Error(`provider event detail failed ${JSON.stringify(providerEventDetail.data)}`);
    const providerPaymentId = `story-provider-pay-${Date.now()}`;
    const providerEventPayload = {
      provider_code: "mock_provider",
      provider_event_id: `story-provider-evt-${Date.now()}`,
      provider_payment_id: providerPaymentId,
      provider_session_id: `story-provider-session-${Date.now()}`,
      invoice_id: providerEventInvoice.data.invoice_id,
      event_type: "authorized",
      provider_status: "authorized",
      amount_jpyc_base: providerEventDetail.data.amounts.amount_jpyc_base,
      occurred_at: new Date().toISOString(),
    };
    const providerEventIdem = idem("provider-event-ingest");
    await request("provider event ingest", ["ES-008", "AS-014"], "/api/v1/provider-rail/mock/events:ingest", {
      method: "POST",
      headers: buildServiceAuthHeaders(env, providerEventPayload, providerEventIdem),
      body: JSON.stringify(providerEventPayload),
    });
    const providerSettlementPayload = {
      provider_code: "mock_provider",
      provider_settlement_id: `story-provider-settlement-${Date.now()}`,
      batch_reference: `story-provider-batch-${Date.now()}`,
      settlement_status: "reported",
      settlement_amount_jpyc_base: providerEventDetail.data.amounts.amount_jpyc_base,
      allocations: [
        {
          provider_payment_id: providerPaymentId,
          invoice_id: providerEventInvoice.data.invoice_id,
          allocated_amount_jpyc_base: providerEventDetail.data.amounts.amount_jpyc_base,
          allocation_status: "matched",
        },
      ],
    };
    const providerSettlementIdem = idem("provider-settlement-ingest");
    await request("provider settlement ingest", ["AS-014"], "/api/v1/provider-rail/mock/settlements:ingest", {
      method: "POST",
      headers: buildServiceAuthHeaders(env, providerSettlementPayload, providerSettlementIdem),
      body: JSON.stringify(providerSettlementPayload),
    });
    await request("invoice cleanup cancel after provider event", ["ES-004"], `/api/v1/invoices/${encodeURIComponent(providerEventInvoice.data.invoice_id)}/cancel`, {
      method: "POST",
      headers: headers({ "content-type": "application/json", "idempotency-key": idem("provider-event-invoice-cancel") }),
      body: "{}",
    }, [200, 409]);

    const addressesAfterInvoices = await request("receive address list after invoices", ["AS-005"], "/api/v1/admin/receive-addresses", { headers: headers() });
    const addressToDisable = addressesAfterInvoices.data.receive_addresses.find((row) => row.status === "available");
    if (!addressToDisable) throw new Error("no available receive address left to disable");
    await request("receive address disable", ["AS-005"], `/api/v1/admin/receive-addresses/${encodeURIComponent(addressToDisable.id)}/disable`, {
      method: "POST",
      headers: headers({ "content-type": "application/json", "idempotency-key": idem("address-disable") }),
      body: JSON.stringify({ reason: "story_api_retest" }),
    });

    await request("chain monitor status denied for store admin", ["AS-010"], "/api/v1/chain-monitor/status", { headers: headers() }, [403]);
    await request("chain monitor unmatched denied for store admin", ["AS-010"], "/api/v1/chain-monitor/unmatched?limit=5", { headers: headers() }, [403]);
    await request("chain monitor dead letters denied for store admin", ["AS-010"], "/api/v1/chain-monitor/dead-letters?limit=5", { headers: headers() }, [403]);

    await request("audit log list", ["AS-009"], "/api/v1/audit-logs?limit=20", { headers: headers() });
    await request("audit chain verify denied for store admin", ["AS-009", "AS-017"], "/api/v1/audit-logs/verify-chain", { headers: headers() }, [403]);
    await request("audit csv export", ["AS-009"], "/api/v1/audit-logs/export", { headers: headers() });

    const reviewListForDetail = await request("review list for detail", ["AS-006"], "/api/v1/reviews?status=open&limit=10", { headers: headers() });
    const reviewForPatch = reviewListForDetail.data.reviews?.[0];
    if (reviewForPatch?.id) {
      await request("review detail read", ["AS-006", "US-006"], `/api/v1/reviews/${encodeURIComponent(reviewForPatch.id)}`, { headers: headers() });
      await request("review patch in progress", ["AS-007"], `/api/v1/reviews/${encodeURIComponent(reviewForPatch.id)}`, {
        method: "PATCH",
        headers: headers({ "content-type": "application/json", "idempotency-key": idem("review-patch") }),
        body: JSON.stringify({ status: "in_progress", admin_note: "story_api_retest" }),
      });
    }

    const businessDate = new Date().toISOString().slice(0, 10);
    const yearMonth = businessDate.slice(0, 7);
    await request("settlement daily status", ["AS-011"], `/api/v1/settlements/daily-status?business_date=${businessDate}`, { headers: headers() });
    await request("settlement daily export", ["AS-011", "AS-012"], `/api/v1/settlements/daily:export?business_date=${businessDate}&format=json`, { headers: headers() });
    await request("settlement monthly export", ["AS-013"], `/api/v1/settlements/monthly:export?year_month=${yearMonth}&format=json`, { headers: headers() });
    const settlementExport = await request(
      "settlement export snapshot",
      ["AS-012"],
      "/api/v1/settlement-exports",
      {
        method: "POST",
        headers: headers({ "content-type": "application/json", "idempotency-key": idem("settlement-export") }),
        body: JSON.stringify({ business_date: businessDate, format: "json" }),
      },
      [201]
    );
    await request("settlement export read", ["AS-012"], `/api/v1/settlement-exports/${encodeURIComponent(settlementExport.data.export_id)}`, { headers: headers() });
    await request("settlement export download csv", ["AS-012"], `/api/v1/settlement-exports/${encodeURIComponent(settlementExport.data.export_id)}/download?format=csv`, { headers: headers() });

    await request("store settings", ["US-007"], `/api/v1/stores/${encodeURIComponent(admin.storeId)}/settings`, { headers: headers() }, [200]);
    await request("readyz metrics-auth expected NO_GO", ["AS-015", "AS-020"], "/readyz", { headers: { authorization: `Bearer ${env.METRICS_SECRET}` } }, [503]);
    await request("prometheus metrics", ["AS-020"], "/metrics", { headers: { authorization: `Bearer ${env.METRICS_SECRET}` } });

    record(["AS-016", "AS-018", "AS-019", "AS-021"], "guardrail/readiness scripts remain covered by npm run check, production validators, and workbook crosswalk", "covered_by_existing_validation", {
      note: "These stories are script/docs/gate oriented and are not all runtime API actions.",
    });

    const manifest = {
      generated_at: new Date().toISOString(),
      output_dir: path.relative(ROOT, OUT_DIR),
      base_url: started.baseUrl,
      production_data_used: false,
      protected_data_modified: false,
      env_boundary: "temporary local DB from tests/helpers/baseServerEnv",
      stories_covered: [...new Set(assertions.flatMap((row) => row.story_ids))].sort(),
      assertion_count: assertions.length,
      evidence_count: evidence.length,
      assertions,
      evidence,
    };
    await writeJson(path.join(OUT_DIR, "manifest.json"), manifest);
    console.log(JSON.stringify(manifest, null, 2));
  } finally {
    if (started?.proc) await stopServerProcess(started.proc);
  }
}

run().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
