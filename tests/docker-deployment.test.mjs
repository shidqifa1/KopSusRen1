import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const dockerfile=fs.readFileSync(new URL('../Dockerfile',import.meta.url),'utf8');
const compose=fs.readFileSync(new URL('../compose.yml',import.meta.url),'utf8');
const gitignore=fs.readFileSync(new URL('../.gitignore',import.meta.url),'utf8');
const dockerignore=fs.readFileSync(new URL('../.dockerignore',import.meta.url),'utf8');
const serverEnv=fs.readFileSync(new URL('../.env.server.example',import.meta.url),'utf8');
const setupScriptUrl=new URL('../setup-server.sh',import.meta.url);
const setupScript=fs.readFileSync(setupScriptUrl,'utf8');

test('Docker image has separate web and gateway production targets',()=>{
  assert.match(dockerfile,/FROM runtime-deps AS web/);
  assert.match(dockerfile,/FROM runtime-deps AS gateway/);
  assert.match(dockerfile,/RUN npx tsc -p tsconfig\.docker\.json/);
  assert.match(dockerfile,/USER node/);
});

test('compose connects gateway to the same web API and persists WhatsApp session',()=>{
  assert.match(compose,/WA_BACKEND_URL: http:\/\/web:3000\/api\/v2\/commands/);
  assert.match(compose,/whatsapp_session:\/app\/data/);
  assert.match(compose,/condition: service_healthy/);
  assert.match(compose,/Caddyfile:\/etc\/caddy\/Caddyfile:ro/);
});

test('local secrets and WhatsApp credentials cannot enter Git or Docker context',()=>{
  for(const source of [gitignore,dockerignore]) {
    assert.match(source,/\.env\.\*/);
    assert.match(source,/baileys_auth/);
  }
  assert.match(gitignore,/!\.env\.server\.example/);
  assert.match(dockerignore,/!\.env\.server\.example/);
  assert.doesNotMatch(serverEnv,/gsk_[A-Za-z0-9_-]{20,}/);
  assert.match(serverEnv,/YOUR_PASSWORD/);
  assert.match(serverEnv,/replace-with-random-auth-secret/);
  assert.match(serverEnv,/replace-with-random-wa-secret/);
});

test('interactive server setup creates private env and controls the complete stack',()=>{
  assert.ok(fs.statSync(setupScriptUrl).mode & 0o100,'setup-server.sh must be executable');
  assert.match(setupScript,/chmod 600 "\$ENV_FILE"/);
  assert.match(setupScript,/docker compose --env-file "\$ENV_FILE" config/);
  assert.match(setupScript,/docker compose --env-file "\$ENV_FILE" up -d --build/);
  assert.match(setupScript,/Buat username admin web baru/);
  assert.match(setupScript,/Password mentah tidak disimpan/);
  assert.match(setupScript,/VALID_USERNAME=%s/);
  assert.match(setupScript,/VALID_PASSWORD_HASH=%s/);
  assert.match(setupScript,/WA_SHARED_SECRET=%s/);
  assert.doesNotMatch(setupScript,/gsk_[A-Za-z0-9_-]{20,}/);
});
