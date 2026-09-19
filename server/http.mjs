import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import authHandler from '../dist/api/auth.js';
import stateHandler from '../dist/api/state.js';
import bootstrapHandler from '../dist/api/v2/bootstrap.js';
import commandsHandler from '../dist/api/v2/commands.js';
import exportHandler from '../dist/api/v2/export.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const root = resolve(process.cwd());
const maxBodyBytes = 5 * 1024 * 1024;

const apiRoutes = new Map([
  ['/api/auth', authHandler],
  ['/api/state', stateHandler],
  ['/api/v2/bootstrap', bootstrapHandler],
  ['/api/v2/commands', commandsHandler],
  ['/api/v2/export', exportHandler],
]);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function attachVercelResponse(res) {
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = value => {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(value));
    return res;
  };
  res.send = value => {
    if (typeof value === 'object' && value !== null && !Buffer.isBuffer(value)) return res.json(value);
    res.end(value == null ? '' : String(value));
    return res;
  };
  return res;
}

async function readJsonBody(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || 'GET')) return undefined;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error('Request body terlalu besar');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('JSON tidak valid');
    error.statusCode = 400;
    throw error;
  }
}

function queryObject(url) {
  const result = {};
  for (const [key, value] of url.searchParams) {
    if (result[key] === undefined) result[key] = value;
    else if (Array.isArray(result[key])) result[key].push(value);
    else result[key] = [result[key], value];
  }
  return result;
}

async function serveStatic(pathname, res) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const relative = decodeURIComponent(requested).replace(/^\/+/, '');
  let filePath = resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return false;

  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
  } catch {
    filePath = resolve(root, 'index.html');
  }

  const extension = extname(filePath).toLowerCase();
  res.setHeader('Content-Type', contentTypes[extension] || 'application/octet-stream');
  res.setHeader('Cache-Control', extension === '.html' ? 'no-cache' : 'public, max-age=3600');
  res.statusCode = 200;
  res.end(await readFile(filePath));
  return true;
}

const server = createServer(async (req, rawRes) => {
  const res = attachVercelResponse(rawRes);
  applySecurityHeaders(res);
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/healthz') return res.status(200).json({ ok: true });

    const handler = apiRoutes.get(url.pathname);
    if (handler) {
      req.query = queryObject(url);
      req.body = await readJsonBody(req);
      return await handler(req, res);
    }

    if (!['GET', 'HEAD'].includes(req.method || 'GET')) return res.status(405).send('Method not allowed');
    if (!(await serveStatic(url.pathname, res))) return res.status(404).send('Not found');
  } catch (error) {
    console.error('http_request_failed', error);
    if (!res.headersSent) res.status(error.statusCode || 500).json({ ok: false, error: error.statusCode ? error.message : 'Terjadi kesalahan pada server' });
    else res.end();
  }
});

server.listen(port, host, () => console.log(`Kopi Manager web listening on ${host}:${port}`));

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
