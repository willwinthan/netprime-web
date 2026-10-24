// Versioned Web Crypto hashes; rehash legacy salted SHA-256 on successful login.
const ITERATIONS = 100_000; // Supported by the target Workers Web Crypto runtime.
const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const fromHex = (value: string) => Uint8Array.from(value.match(/../g) || [], byte => parseInt(byte, 16));

function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt).buffer, iterations }, key, 256);
  return hex(new Uint8Array(bits));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${ITERATIONS}$${hex(salt)}$${await derive(password, salt, ITERATIONS)}`;
}

export function needsPasswordUpgrade(stored: string): boolean {
  return !stored.startsWith(`pbkdf2-sha256$${ITERATIONS}$`);
}

export async function verifyPassword(password: string, stored: string, allowPlaintext = false): Promise<boolean> {
  if (!stored) return false;
  if (stored.startsWith("pbkdf2-sha256$")) {
    const parts = stored.split("$");
    const iterations = Number(parts[1]);
    if (parts.length !== 4 || !Number.isInteger(iterations) || iterations < 10_000 || iterations > ITERATIONS ||
        !/^[a-f0-9]{32}$/.test(parts[2]) || !/^[a-f0-9]{64}$/.test(parts[3])) return false;
    return equal(await derive(password, fromHex(parts[2]), iterations), parts[3]);
  }
  const parts = stored.split(":");
  if (parts.length === 2 && /^[a-f0-9]{64}$/.test(parts[1])) {
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(parts[0] + password));
    return equal(hex(new Uint8Array(digest)), parts[1]);
  }
  return allowPlaintext && equal(password, stored);
}
