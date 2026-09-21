// Generate a VAPID key pair for Web Push.
//
//   node tools/vapid-keys.mjs
//
// Prints a public and a private key in the base64url form the app expects.
// Put them in the Cloudflare Pages dashboard as VAPID_PUBLIC_KEY and
// VAPID_PRIVATE_KEY, then redeploy — environment variables only reach the
// running app on a fresh deployment.
//
// Run this on your own machine and paste the values into the dashboard
// yourself. Nothing here writes a key to a file, and no key should ever be
// committed or pasted into a chat.

import { webcrypto as crypto } from "node:crypto";

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const pub = await crypto.subtle.exportKey("raw", pair.publicKey);       // 0x04 | X | Y
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);

console.log("VAPID_PUBLIC_KEY   ", b64url(pub));
console.log("VAPID_PRIVATE_KEY  ", jwk.d);
console.log("VAPID_SUBJECT      ", "mailto:you@example.com   (change to a real contact)");
console.log("\nSet these three in the Cloudflare Pages dashboard, then trigger a new deployment.");
