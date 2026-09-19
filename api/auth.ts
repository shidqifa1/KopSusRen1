import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyPassword, createToken } from "./_auth.js";

const VALID_USERNAME = process.env.VALID_USERNAME || "shidqifa";

const ENV_HASH = process.env.VALID_PASSWORD_HASH;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const loginAttempts = new Map<string, { count: number; resetAt: number; blockedUntil: number }>();

function clientKey(req: VercelRequest) {
  const forwarded = req.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return String(value || req.socket?.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 80);
}

function currentAttempt(key: string, now = Date.now()) {
  const existing = loginAttempts.get(key);
  if (!existing || existing.resetAt <= now) {
    const fresh = { count: 0, resetAt: now + LOGIN_WINDOW_MS, blockedUntil: 0 };
    loginAttempts.set(key, fresh);
    return fresh;
  }
  return existing;
}

function pruneAttempts(now = Date.now()) {
  if (loginAttempts.size <= 1000) return;
  for (const [key, value] of loginAttempts) {
    if (value.resetAt <= now && value.blockedUntil <= now) loginAttempts.delete(key);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const { username = "", password = "" } = req.body || {};
  const key = clientKey(req);
  const now = Date.now();
  const attempt = currentAttempt(key, now);
  if (attempt.blockedUntil > now) {
    res.setHeader('Retry-After', String(Math.ceil((attempt.blockedUntil - now) / 1000)));
    return res.status(429).json({ ok: false, error: "Terlalu banyak percobaan login. Coba lagi nanti." });
  }

  if (!ENV_HASH || !process.env.AUTH_SECRET) {
    return res.status(503).json({ ok: false, error: "Konfigurasi login server belum lengkap" });
  }

  if (!username || !password) {
    return res.status(400).json({ ok: false, error: "Username dan password wajib diisi" });
  }

  if (String(username).length > 80 || String(password).length > 256) {
    return res.status(401).json({ ok: false, error: "Username atau password salah" });
  }

  const passwordValid = verifyPassword(password, ENV_HASH);

  if (username === VALID_USERNAME && passwordValid) {
    loginAttempts.delete(key);
    const token = createToken(username);
    return res.status(200).json({ ok: true, token });
  }

  attempt.count += 1;
  if (attempt.count >= MAX_LOGIN_FAILURES) attempt.blockedUntil = now + LOGIN_BLOCK_MS;
  loginAttempts.set(key, attempt);
  pruneAttempts(now);

  return res.status(401).json({
    ok: false,
    error: "Username atau password salah"
  });
}
