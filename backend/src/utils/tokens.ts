/**
 * Single-use account links (password reset, invitation, email verification).
 * Only the SHA-256 hash of a token is stored; the raw token travels in the emailed link.
 */
export type TokenPurpose = "reset" | "invite" | "verify";

export const TOKEN_TTL: Record<TokenPurpose, number> = {
  reset: 60 * 60,            // 1 hour
  invite: 7 * 24 * 60 * 60,  // 7 days
  verify: 3 * 24 * 60 * 60   // 3 days
};

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Issues a new token and invalidates older unused tokens of the same purpose for that user. */
export async function issueAccountToken(db: D1Database, userId: string, purpose: TokenPurpose, ttlSeconds = TOKEN_TTL[purpose]): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await db.batch([
    db.prepare("UPDATE account_tokens SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND purpose = ? AND used_at IS NULL").bind(userId, purpose),
    db.prepare("INSERT INTO account_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256(token), userId, purpose, expires)
  ]);
  return token;
}

/**
 * Marks a valid token as used and returns its user, or null when unknown, expired or already used.
 * `purposes` lists what the caller accepts (an invitation link also sets a password).
 */
export async function consumeAccountToken(db: D1Database, token: string, purposes: TokenPurpose[]): Promise<{ user_id: string; purpose: TokenPurpose } | null> {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
  const hash = await sha256(token);
  const row = await db.prepare(`UPDATE account_tokens SET used_at = CURRENT_TIMESTAMP
    WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? AND purpose IN (${purposes.map(() => "?").join(", ")})
    RETURNING user_id, purpose`).bind(hash, new Date().toISOString(), ...purposes).first<{ user_id: string; purpose: TokenPurpose }>();
  return row ?? null;
}

export async function purgeExpiredTokens(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM account_tokens WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < datetime('now', '-30 days'))")
    .bind(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()).run();
}
