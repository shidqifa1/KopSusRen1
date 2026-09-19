import { randomBytes, scryptSync } from 'node:crypto';

const password = process.argv[2];
if (!password) {
  console.error('Gunakan: npm run generate:secrets -- "password-kamu"');
  process.exit(1);
}
const salt = randomBytes(16).toString('hex');
const hash = scryptSync(password + 'kopsusren-app-2024', salt, 64).toString('hex');
console.log(`AUTH_SECRET=${randomBytes(48).toString('hex')}`);
console.log(`VALID_PASSWORD_HASH=${salt}:${hash}`);
