import { spawnSync } from 'node:child_process';
import path from 'node:path';

const cli = path.resolve('node_modules/vercel/dist/vc.js');
const keys = [
  'DATABASE_URL',
  'SUPABASE_URL',
  'APP_ENV',
  'AUTH_SECRET',
  'VALID_USERNAME',
  'VALID_PASSWORD_HASH',
  'WA_SHARED_SECRET',
];

if (process.env.GROQ_API_KEY) keys.push('GROQ_API_KEY');
if (process.env.GROQ_MODEL) keys.push('GROQ_MODEL');
if (process.env.WA_OWNER_NUMBERS) keys.push('WA_OWNER_NUMBERS');
if (process.env.QRIS_IMAGE_URL) keys.push('QRIS_IMAGE_URL');
if (process.env.CHATBOT_V2_ENABLED) keys.push('CHATBOT_V2_ENABLED');
if (process.env.CHATBOT_MODE) keys.push('CHATBOT_MODE');

for (const key of keys) {
  const value = process.env[key];
  if (!value) throw new Error(`Variabel ${key} belum tersedia di .env.local`);

  const result = spawnSync(process.execPath, [
    cli,
    'env',
    'add',
    key,
    'production,preview,development',
    '--force',
    '--sensitive',
    '--yes',
  ], {
    cwd: process.cwd(),
    input: `${value}\n`,
    encoding: 'utf8',
    env: process.env,
  });

  if (result.status !== 0) {
    const detail = `${result.stdout || ''}\n${result.stderr || ''}`
      .replaceAll(value, '[REDACTED]')
      .trim();
    throw new Error(`Gagal menyimpan ${key} ke Vercel: ${detail}`);
  }

  console.log(`✓ ${key}`);
}

console.log('Semua environment variable Vercel tersimpan.');
