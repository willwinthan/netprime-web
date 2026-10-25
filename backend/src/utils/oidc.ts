/**
 * OpenID Connect relying-party helpers for enterprise SSO (Microsoft Entra ID, Google Workspace, Okta…).
 * Authorization code flow with PKCE (S256), state and nonce; ID tokens are verified locally against
 * the IdP's JWKS (RS256 or ES256) with iss/aud/azp/exp/iat/nonce checks.
 *
 * No local imports: tests/oidc-verify.test.mjs imports this file directly under Node with a locally
 * generated key pair. Network helpers take the KV namespace and fetch function as parameters.
 */

export class OidcError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}

export interface Jwk { kty: string; kid?: string; alg?: string; use?: string; n?: string; e?: string; crv?: string; x?: string; y?: string }
export interface Jwks { keys: Jwk[] }

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
}

export interface IdTokenClaims {
  iss: string; sub: string; aud: string | string[]; exp: number; iat?: number; nonce?: string; azp?: string;
  email?: string; email_verified?: boolean | string; name?: string; preferred_username?: string; hd?: string; tid?: string;
  [claim: string]: unknown;
}

export const SUPPORTED_ALGS = ["RS256", "ES256"] as const;

const encoder = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new OidcError("malformed_token");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const decodeJson = (part: string) => {
  try { return JSON.parse(new TextDecoder().decode(b64urlDecode(part))); } catch { throw new OidcError("malformed_token"); }
};

/** Random URL-safe value (state, nonce, PKCE verifier: 32 bytes → 43 chars). */
export function randomValue(bytes = 32): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** PKCE S256 code_challenge for a verifier (RFC 7636). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64urlEncode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
}

/** Normalizes an issuer URL for comparison (no trailing slash). */
export const normalizeIssuer = (issuer: string) => issuer.trim().replace(/\/+$/, "");

/** Validates a discovery document against the configured issuer; every endpoint must be https. */
export function validateDiscovery(doc: unknown, issuer: string): Discovery {
  const d = doc as Partial<Discovery> | null;
  if (!d || typeof d !== "object") throw new OidcError("discovery_invalid");
  if (typeof d.issuer !== "string" || normalizeIssuer(d.issuer) !== normalizeIssuer(issuer)) throw new OidcError("issuer_mismatch");
  for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    const value = d[key];
    if (typeof value !== "string") throw new OidcError("discovery_invalid");
    try { if (new URL(value).protocol !== "https:") throw new Error(); } catch { throw new OidcError("discovery_insecure"); }
  }
  if (Array.isArray(d.code_challenge_methods_supported) && !d.code_challenge_methods_supported.includes("S256")) {
    throw new OidcError("pkce_unsupported");
  }
  return d as Discovery;
}

async function importKey(jwk: Jwk, alg: string): Promise<CryptoKey> {
  if (alg === "RS256") {
    if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) throw new OidcError("key_mismatch");
    return crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true } as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) throw new OidcError("key_mismatch");
  return crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, ext: true } as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

/** Header kid of a JWT (to decide whether the cached JWKS must be refreshed). */
export function tokenKid(token: string): string | undefined {
  const header = decodeJson(token.split(".")[0] || "");
  return typeof header?.kid === "string" ? header.kid : undefined;
}

export interface VerifyOptions {
  issuer: string;
  clientId: string;
  nonce: string;
  jwks: Jwks;
  /** Unix seconds; defaults to now. */
  now?: number;
  skewSeconds?: number;
}

/**
 * Verifies an ID token and returns its claims; throws OidcError with a stable code otherwise.
 * Rejects alg "none"/HS*, unknown kid, bad signature, wrong iss/aud/azp, expired or future-issued
 * tokens and a nonce that does not match the one stored with the login state.
 */
export async function verifyIdToken(token: string, options: VerifyOptions): Promise<IdTokenClaims> {
  if (typeof token !== "string" || token.length > 16_384) throw new OidcError("malformed_token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new OidcError("malformed_token");
  const header = decodeJson(parts[0]);
  const claims = decodeJson(parts[1]) as IdTokenClaims;
  const alg = header?.alg;
  if (!(SUPPORTED_ALGS as readonly string[]).includes(alg)) throw new OidcError("unsupported_alg");
  const candidates = (options.jwks?.keys || []).filter(k =>
    (header.kid ? k.kid === header.kid : true) && (!k.use || k.use === "sig") && (!k.alg || k.alg === alg) &&
    (alg === "RS256" ? k.kty === "RSA" : k.kty === "EC"));
  if (!candidates.length) throw new OidcError("unknown_key");
  const data = encoder.encode(`${parts[0]}.${parts[1]}`);
  const signature = b64urlDecode(parts[2]);
  let valid = false;
  for (const jwk of candidates) {
    const key = await importKey(jwk, alg);
    const params = alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" };
    if (await crypto.subtle.verify(params, key, signature, data)) { valid = true; break; }
  }
  if (!valid) throw new OidcError("bad_signature");

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const skew = options.skewSeconds ?? 120;
  if (typeof claims.iss !== "string" || normalizeIssuer(claims.iss) !== normalizeIssuer(options.issuer)) throw new OidcError("issuer_mismatch");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(options.clientId)) throw new OidcError("audience_mismatch");
  if (audiences.length > 1 && claims.azp !== options.clientId) throw new OidcError("audience_mismatch");
  if (claims.azp !== undefined && claims.azp !== options.clientId) throw new OidcError("audience_mismatch");
  if (!Number.isFinite(claims.exp) || claims.exp + skew < now) throw new OidcError("token_expired");
  if (claims.iat !== undefined && (!Number.isFinite(claims.iat) || claims.iat - skew > now)) throw new OidcError("token_not_yet_valid");
  if (!options.nonce || claims.nonce !== options.nonce) throw new OidcError("nonce_mismatch");
  if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) throw new OidcError("missing_subject");
  return claims;
}

/**
 * Email the IdP asserts for the user (the `email` claim only), lower-cased, or null. An explicit
 * email_verified=false is rejected. `preferred_username` is never used: on Entra ID it is a
 * user-editable UPN-like value and must not identify or link accounts.
 */
export function assertedEmail(claims: IdTokenClaims): string | null {
  if (claims.email_verified === false || claims.email_verified === "false") return null;
  const candidate = typeof claims.email === "string" ? claims.email : "";
  const email = candidate.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

/**
 * True only when the IdP positively asserts the email is verified: `email_verified: true` (OIDC) or
 * Entra ID's optional `xms_edov: true` (email domain owner verified). A missing claim is NOT verified.
 */
export function emailVerifiedClaim(claims: IdTokenClaims): boolean {
  return claims.email_verified === true || claims.email_verified === "true" || claims.xms_edov === true || claims.xms_edov === "true";
}

export const emailDomain = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

// ---------- Network helpers (discovery / JWKS cached in KV) ----------

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
const CACHE_TTL = 3600;

async function getJson(fetcher: Fetcher, url: string): Promise<unknown> {
  const res = await fetcher(url, { headers: { Accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new OidcError("idp_unreachable");
  const text = await res.text();
  if (text.length > 200_000) throw new OidcError("idp_response_too_large");
  try { return JSON.parse(text); } catch { throw new OidcError("idp_invalid_json"); }
}

export async function loadDiscovery(kv: KVNamespace, issuer: string, fetcher: Fetcher = fetch, force = false): Promise<Discovery> {
  const key = `oidc-disc:${normalizeIssuer(issuer)}`;
  if (!force) {
    const cached = await kv.get(key, "json") as Discovery | null;
    if (cached) return cached;
  }
  const doc = validateDiscovery(await getJson(fetcher, `${normalizeIssuer(issuer)}/.well-known/openid-configuration`), issuer);
  await kv.put(key, JSON.stringify(doc), { expirationTtl: CACHE_TTL });
  return doc;
}

/** JWKS from cache; refreshed when `force` (unknown kid → key rotation) or expired. */
export async function loadJwks(kv: KVNamespace, jwksUri: string, fetcher: Fetcher = fetch, force = false): Promise<Jwks> {
  const key = `oidc-jwks:${jwksUri}`;
  if (!force) {
    const cached = await kv.get(key, "json") as Jwks | null;
    if (cached) return cached;
  }
  const doc = await getJson(fetcher, jwksUri) as Jwks;
  if (!doc || !Array.isArray(doc.keys)) throw new OidcError("jwks_invalid");
  await kv.put(key, JSON.stringify({ keys: doc.keys.slice(0, 50) }), { expirationTtl: CACHE_TTL });
  return doc;
}
