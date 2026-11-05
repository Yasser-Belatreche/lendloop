// HMAC-SHA256 over `${timestamp}.${rawBody}`, hex encoded, sent as
//   X-LendLoop-Timestamp: <unix seconds>
//   X-LendLoop-Signature: sha256=<hex>
// The timestamp is part of the signed string and must be within MAX_SKEW_SECONDS,
// so a captured request cannot be replayed later. Web Crypto only (Convex runtime).

export const MAX_SKEW_SECONDS = 300;

const encoder = new TextEncoder();

async function key(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function toHex(buf: ArrayBuffer) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sign(secret: string, timestamp: string, body: string) {
  const mac = await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(`${timestamp}.${body}`));
  return `sha256=${toHex(mac)}`;
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verify(
  secret: string | undefined,
  timestamp: string | null,
  signature: string | null,
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!secret) return { ok: false, reason: "secret not configured" };
  if (!timestamp || !signature) return { ok: false, reason: "missing signature headers" };
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS) {
    return { ok: false, reason: "stale or invalid timestamp" };
  }
  const expected = await sign(secret, timestamp, body);
  return timingSafeEqual(expected, signature) ? { ok: true } : { ok: false, reason: "bad signature" };
}
