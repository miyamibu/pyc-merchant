import crypto from "node:crypto";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function hmac(secret, value) {
  return crypto.createHmac("sha256", String(secret)).update(String(value)).digest("hex");
}

export function buildServiceAuthHeaders(env, payload, idempotencyKey) {
  const serviceId = String(env.SERVICE_INGEST_ID || "chain-monitor");
  const serviceKid = String(env.SERVICE_HMAC_ACTIVE_KID || "service-v1");
  const ringEntry = String(env.SERVICE_HMAC_KEYS || "")
    .split(",")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${serviceKid}=`));
  const serviceSecret = ringEntry ? ringEntry.slice(serviceKid.length + 1) : env.SERVICE_INGEST_SECRET;
  const timestamp = Math.floor(Date.now() / 1000);
  const payloadHash = sha256(JSON.stringify(payload || {}));
  const signature = hmac(
    serviceSecret,
    `service.${serviceKid}.${serviceId}.${timestamp}.${idempotencyKey}.${payloadHash}`
  );
  return {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    "x-service-id": serviceId,
    "x-service-kid": serviceKid,
    "x-service-timestamp": String(timestamp),
    "x-service-signature": signature,
    "x-service-jti": idempotencyKey,
  };
}
