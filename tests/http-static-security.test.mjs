import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('local HTTP server exposes public assets but never internal files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'baristack-http-'));
  for (const dir of ['server', 'dist/api/v2', 'assets', 'src/services', 'baileys_auth', '.git', 'node_modules']) {
    await mkdir(join(root, dir), { recursive: true });
  }
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await copyFile(new URL('../server/http.mjs', import.meta.url), join(root, 'server/http.mjs'));
  for (const route of ['auth', 'state', 'v2/bootstrap', 'v2/commands', 'v2/export']) {
    await writeFile(join(root, `dist/api/${route}.js`), 'export default (req,res)=>res.status(401).json({ok:false});');
  }
  for (const path of ['.env.local', '.git/config', 'baileys_auth/creds.json', 'node_modules/private.json']) {
    await writeFile(join(root, path), 'PRIVATE_TEST_SENTINEL');
  }
  for (const path of ['index.html', 'styles.css', 'assets/qris-baristack.jpeg', 'src/services/kopsusren.js']) {
    await writeFile(join(root, path), 'PUBLIC_TEST_ASSET');
  }
  await symlink(join(root, '.env.local'), join(root, 'assets/leaked.jpeg'));
  const port = 32000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['server/http.mjs'], {
    cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
    await rm(root, { recursive: true, force: true });
  });
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(() => { throw new Error('HTTP fixture failed to start'); }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('HTTP fixture startup timeout')), 5000).unref()),
  ]);
  for (const path of ['/.env.local', '/%2eenv.local', '/.git/config', '/baileys_auth/creds.json',
    '/node_modules/private.json', '/server/http.mjs', '/dist/api/auth.js', '/package.json', '/assets/leaked.jpeg']) {
    await t.test(`blocks ${path}`, async () => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status, 404);
      assert.doesNotMatch(await response.text(), /PRIVATE_TEST_SENTINEL/);
    });
  }
  for (const path of ['/', '/styles.css', '/assets/qris-baristack.jpeg', '/src/services/kopsusren.js']) {
    await t.test(`serves ${path}`, async () => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'PUBLIC_TEST_ASSET');
    });
  }
  await t.test('API authentication remains enforced', async () => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v2/bootstrap`)).status, 401);
  });
});
