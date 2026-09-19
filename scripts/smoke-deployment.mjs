import { createHmac } from 'node:crypto';

const baseUrl = process.argv[2] || 'https://kopsusren-v2.vercel.app';
const secret = process.env.AUTH_SECRET;
const username = process.env.VALID_USERNAME;
if (!secret || !username) throw new Error('Konfigurasi autentikasi lokal tidak lengkap');

function createToken() {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ sub: username, iat: now, exp: now + 300 })).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

async function requestJson(url, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, options);
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error(`Respons non-JSON (status ${response.status})`); }
      return { response, data };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError;
}

const unauthorized = await fetch(`${baseUrl}/api/v2/bootstrap`);
if (unauthorized.status !== 401) throw new Error(`Proteksi API gagal: status ${unauthorized.status}`);

const headers = { Authorization: `Bearer ${createToken()}` };
const { response: beforeResponse, data: before } = await requestJson(`${baseUrl}/api/v2/bootstrap`, { headers });
if (!beforeResponse.ok || !before.ok) throw new Error(before.error || 'Bootstrap deployment gagal');

const cash = before.accounts.find(account => account.type === 'CASH');
if (!cash) throw new Error('Akun Cash tidak ditemukan');

console.log(JSON.stringify({
  ok: true,
  url: baseUrl,
  environment: before.environment,
  products: before.products.length,
  ingredients: before.ingredients.length,
  orders: before.orders.length,
  protectedApi: true,
  authenticatedBootstrap: true,
  cashBalanceReadable: Number.isFinite(Number(cash.balance)),
}, null, 2));
