import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

// The libsignal dependency writes full SessionEntry objects directly through
// console.info/warn. Besides being noisy, those objects contain ratchet key
// material that must never appear in operational logs. Suppress only those
// exact library messages and leave every other console message untouched.
const originalConsoleInfo = console.info.bind(console);
const originalConsoleWarn = console.warn.bind(console);
console.info = (...args) => {
  if (args[0] === 'Closing session:') return;
  originalConsoleInfo(...args);
};
console.warn = (...args) => {
  if (args[0] === 'Decrypted message with closed session.'
    || args[0] === 'Closing open session in favor of incoming prekey bundle') return;
  originalConsoleWarn(...args);
};

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

const sessionDir = process.env.WA_SESSION_DIR || './baileys_auth';
const backendUrl = process.env.WA_BACKEND_URL || 'http://localhost:3000/api/v2/commands';
const sharedSecret = process.env.WA_SHARED_SECRET || '';
const pairingNumber = (process.env.WA_PAIRING_NUMBER || '').replace(/\D/g, '');
let heartbeatTimer = null;
let reconnectTimer = null;
let currentSocket = null;
let starting = false;
let shuttingDown = false;

if (!sharedSecret) {
  log.error('WA_SHARED_SECRET kosong. Isi dulu .env.local sebelum start gateway.');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extractText(msg) {
  const message = msg.message;
  if (!message) return null;
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return message.imageMessage.caption;
  if (message.videoMessage?.caption) return message.videoMessage.caption;
  return null;
}

function hasImage(msg) {
  return Boolean(msg.message?.imageMessage);
}

async function parseSender(sock, key) {
  const remoteJid = key?.remoteJid;
  if (!remoteJid || remoteJid === 'status@broadcast') return null;
  const [, server] = remoteJid.split('@');
  if (server !== 's.whatsapp.net' && server !== 'lid') return null;

  // WhatsApp sekarang sering memakai LID sebagai alamat chat. Gunakan PN
  // alternatif yang disertakan pada message key, lalu coba mapping Baileys.
  let phoneJid = key?.remoteJidAlt;
  if (!phoneJid?.endsWith('@s.whatsapp.net') && server === 'lid') {
    phoneJid = await sock.signalRepository?.lidMapping?.getPNForLID(remoteJid);
  }
  if (!phoneJid?.endsWith('@s.whatsapp.net') && server === 's.whatsapp.net') {
    phoneJid = remoteJid;
  }

  const phone = String(phoneJid || '').split('@')[0].split(':')[0];
  if (!/^\d+$/.test(phone)) {
    log.warn('LID belum bisa dipetakan ke nomor telepon; pesan tidak diproses demi keamanan role/customer.');
    return null;
  }
  return { phone, remoteJid, phoneJid };
}

function jidForPhone(phone) {
  const normalized = String(phone || '').replace(/\D/g, '').replace(/^0/, '62');
  return normalized ? `${normalized}@s.whatsapp.net` : null;
}

function safePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? `***${digits.slice(-4)}` : 'unknown';
}

async function downloadImageBuffer(url) {
  const response = await fetch(String(url), { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`download QRIS gagal (${response.status})`);
  const contentType = String(response.headers.get('content-type') || '');
  if (!contentType.startsWith('image/')) throw new Error('URL QRIS bukan gambar');
  const declaredSize = Number(response.headers.get('content-length') || 0);
  if (declaredSize > 5 * 1024 * 1024) throw new Error('Gambar QRIS terlalu besar');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) throw new Error('Ukuran gambar QRIS tidak valid');
  return buffer;
}

async function sendBackendMessages(sock, senderJid, out) {
  if (!out || out.duplicate) return;
  if (typeof out.replyText === 'string' && out.replyText.trim()) {
    if (!senderJid) return;
    if (out.qrisImageUrl) {
      try {
        const image = await downloadImageBuffer(out.qrisImageUrl);
        await sock.sendMessage(senderJid, { image, mimetype: 'image/jpeg', caption: out.replyText.trim() });
      } catch (error) {
        log.error({ err: String(error) }, 'upload QRIS gagal, kirim tautan sebagai fallback');
        await sock.sendMessage(senderJid, { text: `${out.replyText.trim()}\n\nBuka QRIS: ${out.qrisImageUrl}` });
      }
    } else {
      await sock.sendMessage(senderJid, { text: out.replyText.trim() });
    }
    log.info('reply bot terkirim');
  }
  for (const notice of out.ownerNotifications || []) {
    const jid = jidForPhone(notice.phone);
    if (jid && notice.text) {
      await sock.sendMessage(jid, { text: String(notice.text).trim() });
      log.info({ to: safePhone(notice.phone) }, 'notifikasi owner terkirim');
    }
  }
  for (const notice of out.customerNotifications || []) {
    const jid = jidForPhone(notice.phone);
    if (jid && notice.text) {
      await sock.sendMessage(jid, { text: String(notice.text).trim() });
      log.info({ to: safePhone(notice.phone) }, 'notifikasi customer terkirim');
    }
  }
}

async function forwardToBackend(payload, action = 'chat_inbound') {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(backendUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sharedSecret}`,
        },
        body: JSON.stringify({ action, payload }),
      });

      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`backend ${response.status}`);
        await sleep(1500 * attempt);
        continue;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        log.warn({ status: response.status, detail: text.slice(0, 250) }, 'backend menolak pesan');
        return null;
      }

      return await response.json();
    } catch (error) {
      lastError = error;
      await sleep(1500 * attempt);
    }
  }

  log.error({ err: String(lastError), key: payload.idempotencyKey }, 'backend tidak bisa dijangkau');
  return null;
}

async function handleMessages(sock, { messages, type }) {
  if (type !== 'notify') return;

  for (const msg of messages) {
    try {
      if (!msg.message || msg.key.fromMe) continue;

      const sender = await parseSender(sock, msg.key);
      if (!sender) {
        log.info({ id: msg.key.id }, 'skip pesan non-private/status/group');
        continue;
      }

      const text = (extractText(msg) || '').trim();
      const image = hasImage(msg);
      if (!text && !image) {
        log.info({ id: msg.key.id }, 'skip pesan tanpa teks');
        continue;
      }

      log.info({ from: safePhone(sender.phone), messageId: msg.key.id, hasImage: image }, 'pesan WA masuk');

      const out = await forwardToBackend({
        phone: sender.phone,
        remoteJid: sender.remoteJid,
        pushName: msg.pushName || null,
        text,
        hasImage: image,
        messageId: msg.key.id,
        waMessageId: msg.key.id,
        idempotencyKey: `wa:${msg.key.id}`,
        receivedAt: new Date().toISOString(),
      });

      await sendBackendMessages(sock, sender.remoteJid, out);
    } catch (error) {
      log.error({ err: String(error), id: msg?.key?.id }, 'gagal proses pesan, lanjut');
    }
  }
}

async function heartbeat(sock, status = 'CONNECTED') {
  const out = await forwardToBackend({
    status,
    metadata: { transport: 'baileys', version: 'v2' },
    idempotencyKey: `heartbeat:${Math.floor(Date.now() / 30000)}`,
  }, 'gateway_heartbeat');
  await sendBackendMessages(sock, null, out);
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    start().catch((error) => {
      log.error({ err: String(error) }, 'gateway gagal start ulang');
      scheduleReconnect();
    });
  }, 3000);
}

async function start() {
  if (starting) return;
  starting = true;
  let state;
  let saveCreds;
  let version;
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(sessionDir));
    ({ version } = await fetchLatestBaileysVersion());
  } finally {
    starting = false;
  }

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Baristack Gateway', 'Chrome', '1.0'],
    printQRInTerminal: !pairingNumber,
  });
  currentSocket = sock;

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('messages.upsert', (upsert) => handleMessages(sock, upsert));

  if (pairingNumber && !state.creds.registered) {
    try {
      const code = await sock.requestPairingCode(pairingNumber);
      log.info(`pairing code untuk ${safePhone(pairingNumber)}: ${code}`);
    } catch (error) {
      log.error({ err: String(error) }, 'gagal minta pairing code');
    }
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      log.info('Scan QR berikut dari WhatsApp > Linked devices > Link a device.');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      if (currentSocket !== sock) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      log.info('Baristack WhatsApp gateway connected.');
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await heartbeat(sock).catch(error => log.warn({ err: String(error) }, 'heartbeat awal gagal'));
      heartbeatTimer = setInterval(() => heartbeat(sock).catch(error => log.warn({ err: String(error) }, 'heartbeat gagal')), 30000);
    }
    if (connection === 'close') {
      if (currentSocket !== sock) return;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      if (shuttingDown) return;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        log.error('WhatsApp logout. Hapus folder sesi lalu pairing ulang.');
        process.exit(2);
      }
      log.warn({ code }, 'koneksi WA putus, reconnect 3 detik...');
      scheduleReconnect();
    }
  });
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'gateway berhenti dengan aman');
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  heartbeatTimer = null;
  reconnectTimer = null;
  try { currentSocket?.end(new Error(`Gateway shutdown: ${signal}`)); } catch {}
  setTimeout(() => process.exit(0), 500);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

start().catch((error) => {
  log.error({ err: String(error) }, 'fatal gateway error');
  scheduleReconnect();
});
