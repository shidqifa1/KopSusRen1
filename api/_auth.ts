import { createHmac, timingSafeEqual, randomBytes, scryptSync } from 'crypto';

const AUTH_SECRET = process.env.AUTH_SECRET;

const PEPPER = 'kopsusren-app-2024';

export function hashPassword(password: string): string {
  const salted = password + PEPPER;
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(salted, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const salt = stored.substring(0, 32);
    const hash = stored.substring(33);
    const salted = password + PEPPER;
    const derivedKey = scryptSync(salted, salt, 64);
    const storedBuf = Buffer.from(hash, 'hex');
    if (derivedKey.length !== storedBuf.length) return false;
    return timingSafeEqual(derivedKey as any, storedBuf as any);
  } catch {
    return false;
  }
}

export function createToken(username: string): string {
  if (!AUTH_SECRET) throw new Error('AUTH_SECRET belum dikonfigurasi');
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: username,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 86400
  })).toString('base64url');
  const signature = createHmac('sha256', AUTH_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function verifyToken(token: string): { valid: boolean; username?: string } {
  try {
    if (!AUTH_SECRET) return { valid: false };
    const parts = token.split('.');
    if (parts.length !== 3) return { valid: false };

    const expectedSig = createHmac('sha256', AUTH_SECRET).update(`${parts[0]}.${parts[1]}`).digest('base64url');

    const expectedBuf = Buffer.from(expectedSig);
    const actualBuf = Buffer.from(parts[2]);
    if (expectedBuf.length !== actualBuf.length) return { valid: false };
    if (!timingSafeEqual(expectedBuf as any, actualBuf as any)) return { valid: false };

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return { valid: false };
    }

    return { valid: true, username: payload.sub };
  } catch {
    return { valid: false };
  }
}

export function extractToken(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const auth = req.headers['authorization'];
  if (!auth) return null;
  const parts = (Array.isArray(auth) ? auth[0] : auth).split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;
  return parts[1];
}
