import { randomBytes, scryptSync } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';

function hiddenPrompt(label) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error('Jalankan dari terminal interaktif'));
    let value = '';
    process.stdout.write(label);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = char => {
      if (char === '\u0003') {
        process.stdin.setRawMode(false);
        process.stdout.write('\n');
        process.exit(130);
      }
      if (char === '\r' || char === '\n') {
        process.stdin.off('data', onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write('\n');
        resolve(value);
        return;
      }
      if (char === '\u007f') {
        if (value) { value = value.slice(0, -1); process.stdout.write('\b \b'); }
        return;
      }
      value += char;
      process.stdout.write('•');
    };
    process.stdin.on('data', onData);
  });
}

const password = await hiddenPrompt('Buat password login KopSusRen V2: ');
if (password.length < 10) throw new Error('Password minimal 10 karakter');

const envPath = new URL('../.env.local', import.meta.url);
let env = await readFile(envPath, 'utf8');
const salt = randomBytes(16).toString('hex');
const hash = scryptSync(password + 'kopsusren-app-2024', salt, 64).toString('hex');
const secret = randomBytes(48).toString('hex');
env = env.replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET=${secret}`);
env = env.replace(/^VALID_PASSWORD_HASH=.*$/m, `VALID_PASSWORD_HASH=${salt}:${hash}`);
await writeFile(envPath, env, { mode: 0o600 });
await chmod(envPath, 0o600);
console.log('Login development berhasil dikonfigurasi.');
