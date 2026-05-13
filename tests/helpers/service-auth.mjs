import crypto from "node:crypto";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function hmac(secret, value) {
  return crypto.createHmac("sha256", String(secret)).update(String(value)).digest("hex");
}

export function buildServiceAuthHeaders(env, payload, idempotencyKey) {
  const serviceId = String(env.SERVICE_INGEST_ID || "chain-monitor");
  const timestamp = Math.floor(Date.now() / 1000);
  const payloadHash = sha256(JSON.stringify(payload || {}));
  const signature = hmac(
    env.SERVICE_INGEST_SECRET,
    `${serviceId}.${timestamp}.${idempotencyKey}.${payloadHash}`
  );
  return {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    "x-service-id": serviceId,
    "x-service-timestamp": String(timestamp),
    "x-service-signature": signature,
    "x-service-jti": idempotencyKey,
  };
}
