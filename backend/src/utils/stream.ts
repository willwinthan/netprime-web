/**
 * Cloudflare Stream Signed URL Generator
 * Signs video UIDs using RS256 Web Crypto API.
 */

// Helper to convert strings to Base64URL
function base64url(buffer: ArrayBuffer | string): string {
  let binary = "";
  if (typeof buffer === "string") {
    binary = btoa(unescape(encodeURIComponent(buffer)));
  } else {
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    binary = btoa(binary);
  }
  return binary
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Convert PEM string to ArrayBuffer for PKCS#8 import
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const cleanPem = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binary = atob(cleanPem);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** True for the local development keys in wrangler.local.jsonc ("mock-stream-…"). */
export const isMockStreamKey = (key: string | undefined) => !!key && key.includes("mock");

/**
 * Generates a signed token and iframe URL for Cloudflare Stream.
 * Callers must check that both values are configured (503 otherwise); a mock key returns a
 * development token, and an invalid real key throws instead of silently falling back.
 *
 * @param videoUid The Cloudflare Stream Video UID
 * @param privateKeyJwkOrPem The private key in JWK (JSON string) or PKCS#8 PEM format
 * @param keyId The Cloudflare Stream Key ID
 * @param expDurationInSeconds Token expiration (default 3600s / 1hr)
 */
export async function generateStreamSignedUrl(
  videoUid: string,
  privateKeyJwkOrPem: string,
  keyId: string,
  expDurationInSeconds = 3600
): Promise<{ signedUrl: string; token: string; isMock: boolean }> {
  const exp = Math.floor(Date.now() / 1000) + expDurationInSeconds;

  if (isMockStreamKey(privateKeyJwkOrPem) || isMockStreamKey(keyId)) {
    // Local development only: the player shows a sample clip instead of the Stream iframe
    const mockToken = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" })) + "." +
                      base64url(JSON.stringify({ sub: videoUid, exp, kid: "mock_key_id", mock: true })) + "." +
                      "mock_signature_hash";
    return { signedUrl: `https://iframe.videodelivery.net/${videoUid}?token=${mockToken}`, token: mockToken, isMock: true };
  }

  const header = base64url(JSON.stringify({ alg: "RS256", kid: keyId, typ: "JWT" }));
  // Stream expects the key id in the payload as well; downloads stay disabled
  const payload = base64url(JSON.stringify({ sub: videoUid, kid: keyId, exp, downloadable: false }));
  const tokenInput = `${header}.${payload}`;

  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-256" } };
  const cryptoKey = privateKeyJwkOrPem.trim().startsWith("{")
    ? await crypto.subtle.importKey("jwk", JSON.parse(privateKeyJwkOrPem), algorithm, false, ["sign"])
    : await crypto.subtle.importKey("pkcs8", pemToArrayBuffer(privateKeyJwkOrPem), algorithm, false, ["sign"]);

  const signatureBuffer = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(tokenInput));
  const token = `${tokenInput}.${base64url(signatureBuffer)}`;
  return { signedUrl: `https://iframe.videodelivery.net/${videoUid}?token=${token}`, token, isMock: false };
}

/**
 * Creates a Cloudflare Stream Direct Creator Upload using the tus protocol, for videos larger
 * than the Worker request limit. The browser then PATCHes the file in chunks straight to
 * `uploadURL`; the Worker never sees the bytes and the API token never leaves the server.
 * https://developers.cloudflare.com/stream/uploading-videos/direct-creator-uploads/
 */
export async function createStreamDirectUpload(
  accountId: string,
  apiToken: string,
  opts: { uploadLength: number; maxDurationSeconds: number; name: string; creatorId: string }
): Promise<{ uploadURL: string; uid: string }> {
  const b64 = (value: string) => btoa(unescape(encodeURIComponent(value)));
  // tus Upload-Metadata: comma-separated "key base64(value)" pairs; a bare key is a flag
  const metadata = [
    `maxDurationSeconds ${b64(String(opts.maxDurationSeconds))}`,
    `name ${b64(opts.name)}`,
    "requiresignedurls"
  ].join(",");

  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/stream?direct_user=true`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(opts.uploadLength),
      "Upload-Metadata": metadata,
      "Upload-Creator": opts.creatorId
    }
  });
  const uploadURL = response.headers.get("Location");
  const uid = response.headers.get("stream-media-id");
  if (!response.ok || !uploadURL || !uid) {
    throw new Error(`Stream direct upload failed: HTTP ${response.status} ${await response.text().catch(() => "")}`.slice(0, 500));
  }
  return { uploadURL, uid };
}
