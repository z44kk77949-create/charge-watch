// Web Push (RFC 8291 aes128gcm) + VAPID (RFC 8292) over Web Crypto, for
// Cloudflare Pages Functions. Dormant unless VAPID_PUBLIC_KEY /
// VAPID_PRIVATE_KEY (base64url, raw P-256 public point / private scalar) are set.
//
// NOTE: end-to-end delivery must be verified on a real device once VAPID keys
// are configured — the encryption can't be exercised in CI.

const enc = new TextEncoder();
function b64urlToBytes(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  s += "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(bytes) {
  let bin = ""; const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concat(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

// HKDF(salt, ikm, info, len) via Web Crypto.
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8);
  return new Uint8Array(bits);
}

// Sign the VAPID JWT (ES256) with the raw private scalar; x/y come from the
// public point so we can import a full JWK.
async function vapidJwt(env, audience) {
  const pub = b64urlToBytes(env.VAPID_PUBLIC_KEY);          // 0x04 | X(32) | Y(32)
  const x = bytesToB64url(pub.slice(1, 33)), y = bytesToB64url(pub.slice(33, 65));
  const jwk = { kty: "EC", crv: "P-256", d: env.VAPID_PRIVATE_KEY, x, y, ext: true };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const sub = env.VAPID_SUBJECT || "mailto:chargewatch@example.invalid";
  const payload = bytesToB64url(enc.encode(JSON.stringify({ aud: audience, exp, sub })));
  const signingInput = enc.encode(header + "." + payload);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, signingInput)); // raw r||s
  return header + "." + payload + "." + bytesToB64url(sig);
}

// Encrypt `payload` (string) for one subscription per RFC 8291 (aes128gcm).
async function encrypt(payload, p256dhB64, authB64) {
  const uaPublic = b64urlToBytes(p256dhB64);   // subscriber public key (65 bytes)
  const authSecret = b64urlToBytes(authB64);   // 16 bytes
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Ephemeral (application-server) ECDH key pair.
  const asKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey)); // 65 bytes
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));

  // Combine step: IKM = HKDF(auth, ecdh, "WebPush: info\0" | ua_pub | as_pub, 32)
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // Content encryption key + nonce.
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const plaintext = concat(enc.encode(payload), new Uint8Array([0x02])); // single record, pad delimiter 0x02
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, plaintext));

  // aes128gcm header: salt(16) | rs(4) | idlen(1)=65 | keyid(as_pub 65) | ciphertext
  const rs = new Uint8Array([0, 0, 0x10, 0]); // 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

// Send one Web Push. Returns { ok, status }. 404/410 => caller should prune.
export async function sendWebPush(env, sub, payloadObj) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return { ok: false, status: 0 };
  const url = new URL(sub.endpoint);
  const audience = url.origin;
  const [jwt, body] = await Promise.all([
    vapidJwt(env, audience),
    encrypt(JSON.stringify(payloadObj), sub.p256dh, sub.auth),
  ]);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Authorization": `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "86400",
    },
    body,
  });
  return { ok: res.ok, status: res.status };
}
