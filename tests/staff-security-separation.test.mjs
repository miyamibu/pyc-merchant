import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  apiRequest,
  authHeaders,
  baseServerEnv,
  loginAs,
  startServerProcess,
  stopServerProcess,
} from "./helpers/server-process.mjs";

const CWD = process.cwd();

function mutationHeaders(token, idempotencyKey) {
  return authHeaders(token, {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  });
}

test("store admin cannot mint or commandeer a second privileged refund identity", async (t) => {
  const env = baseServerEnv();
  const started = await startServerProcess(CWD, env);
  const db = new Database(env.DB_PATH, { readonly: true });
  t.after(async () => {
    db.close();
    await stopServerProcess(started.proc);
  });

  const admin = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.STAFF_PIN,
    staffName: "Demo Staff",
  });

  const normalStaff = await apiRequest(started.baseUrl, "/api/v1/staff", {
    method: "POST",
    headers: mutationHeaders(admin.token, "staff-security-normal-create"),
    body: JSON.stringify({
      staff_name: "Floor Operator",
      role: "staff",
      pin: "2468",
      status: "active",
    }),
  });
  assert.equal(normalStaff.status, 201);
  const normalStaffId = normalStaff.data.staff.id;

  const normalUpdate = await apiRequest(
    started.baseUrl,
    `/api/v1/staff/${encodeURIComponent(normalStaffId)}`,
    {
      method: "PATCH",
      headers: mutationHeaders(admin.token, "staff-security-normal-update"),
      body: JSON.stringify({ role: "operator" }),
    },
  );
  assert.equal(normalUpdate.status, 200);
  assert.equal(normalUpdate.data.staff.role, "operator");

  const normalPinRotate = await apiRequest(
    started.baseUrl,
    `/api/v1/staff/${encodeURIComponent(normalStaffId)}/pin:rotate`,
    {
      method: "POST",
      headers: mutationHeaders(admin.token, "staff-security-normal-pin"),
      body: JSON.stringify({ new_pin: "2469" }),
    },
  );
  assert.equal(normalPinRotate.status, 200);

  const staffCountBeforeRejectedCreates = Number(
    db.prepare(`SELECT COUNT(*) AS count FROM staff_users`).get().count,
  );
  for (const [label, payload] of [
    ["manager", { staff_name: "Attacker Manager", role: "manager", pin: "7788", status: "active" }],
    ["admin", { staff_name: "Attacker Admin", role: "admin", pin: "7789", status: "active" }],
    ["override", {
      staff_name: "Attacker Override",
      role: "staff",
      pin: "7790",
      status: "active",
      permissions_override: ["refund.approve"],
    }],
  ]) {
    const response = await apiRequest(started.baseUrl, "/api/v1/staff", {
      method: "POST",
      headers: mutationHeaders(admin.token, `staff-security-reject-create-${label}`),
      body: JSON.stringify(payload),
    });
    assert.equal(response.status, 403);
    assert.equal(response.data.error.code, "STAFF_SECURITY_APPROVAL_REQUIRED");
  }
  assert.equal(
    Number(db.prepare(`SELECT COUNT(*) AS count FROM staff_users`).get().count),
    staffCountBeforeRejectedCreates,
  );

  for (const [label, payload] of [
    ["promotion", { role: "manager" }],
    ["override", { permissions_override: ["refund.approve"] }],
  ]) {
    const response = await apiRequest(
      started.baseUrl,
      `/api/v1/staff/${encodeURIComponent(normalStaffId)}`,
      {
        method: "PATCH",
        headers: mutationHeaders(admin.token, `staff-security-reject-update-${label}`),
        body: JSON.stringify(payload),
      },
    );
    assert.equal(response.status, 403);
    assert.equal(response.data.error.code, "STAFF_SECURITY_APPROVAL_REQUIRED");
  }
  const unchangedOperator = db
    .prepare(`SELECT role, permissions_override FROM staff_users WHERE id = ?`)
    .get(normalStaffId);
  assert.equal(unchangedOperator.role, "operator");
  assert.equal(unchangedOperator.permissions_override, null);

  const secondAdminBefore = db
    .prepare(`SELECT role, pin_hash, updated_at FROM staff_users WHERE id = 'staff-002'`)
    .get();
  assert.ok(secondAdminBefore);
  const secondAdminUpdate = await apiRequest(started.baseUrl, "/api/v1/staff/staff-002", {
    method: "PATCH",
    headers: mutationHeaders(admin.token, "staff-security-reject-admin-update"),
    body: JSON.stringify({ role: "staff" }),
  });
  assert.equal(secondAdminUpdate.status, 403);
  assert.equal(secondAdminUpdate.data.error.code, "STAFF_SECURITY_APPROVAL_REQUIRED");

  const secondAdminPinRotate = await apiRequest(
    started.baseUrl,
    "/api/v1/staff/staff-002/pin:rotate",
    {
      method: "POST",
      headers: mutationHeaders(admin.token, "staff-security-reject-admin-pin"),
      body: JSON.stringify({ new_pin: "9999" }),
    },
  );
  assert.equal(secondAdminPinRotate.status, 403);
  assert.equal(secondAdminPinRotate.data.error.code, "STAFF_SECURITY_APPROVAL_REQUIRED");

  const selfPinRotate = await apiRequest(
    started.baseUrl,
    "/api/v1/staff/staff-001/pin:rotate",
    {
      method: "POST",
      headers: mutationHeaders(admin.token, "staff-security-reject-self-pin"),
      body: JSON.stringify({ new_pin: "9998" }),
    },
  );
  assert.equal(selfPinRotate.status, 403);
  assert.equal(selfPinRotate.data.error.code, "STAFF_SECURITY_APPROVAL_REQUIRED");

  const secondAdminAfter = db
    .prepare(`SELECT role, pin_hash, updated_at FROM staff_users WHERE id = 'staff-002'`)
    .get();
  assert.deepEqual(secondAdminAfter, secondAdminBefore);

  for (const [staffName, pin] of [["Demo Approver", "9999"], ["Demo Staff", "9998"]]) {
    const attackerLogin = await apiRequest(started.baseUrl, "/api/v1/terminal-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ terminalCode: env.TERMINAL_CODE, staffPin: pin, staffName }),
    });
    assert.equal(attackerLogin.status, 401);
  }

  const legitimateApprover = await loginAs(started.baseUrl, {
    terminalCode: env.TERMINAL_CODE,
    pin: env.SECOND_ADMIN_PIN,
    staffName: "Demo Approver",
  });
  assert.equal(legitimateApprover.role, "admin");

  const rejectedAudits = db
    .prepare(`SELECT after_state FROM audit_logs WHERE action = 'staff.security_change_rejected' ORDER BY created_at`)
    .all();
  assert.equal(rejectedAudits.length, 8);
  const serializedAudits = JSON.stringify(rejectedAudits);
  for (const secretPin of ["7788", "7789", "7790", "9999", "9998"]) {
    assert.equal(serializedAudits.includes(secretPin), false);
  }
});
