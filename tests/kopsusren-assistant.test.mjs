import test from 'node:test';
import assert from 'node:assert/strict';
import { answerCustomerWithGroq, answerOwnerWithGroq } from '../services/ai/kopsusrenAssistant.js';

test('customer assistant receives bounded knowledge and live context', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GROQ_API_KEY;
  let requestBody;
  process.env.GROQ_API_KEY = 'test-key';
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Americano cocok kalau kamu kurang suka manis.' } }] }), { status: 200 });
  };
  try {
    const answer = await answerCustomerWithGroq({
      question: 'Yang nggak manis apa?',
      currentOrder: { items: [] },
      snapshot: { latestPo: { status: 'OPEN' } },
    });
    assert.match(answer, /Americano/);
    assert.match(requestBody.messages[0].content, /Jangan mengarang stok/);
    assert.match(requestBody.messages[1].content, /OPEN/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalKey;
  }
});

test('owner assistant is explicitly read-only', async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GROQ_API_KEY;
  let requestBody;
  process.env.GROQ_API_KEY = 'test-key';
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Ada satu pembayaran yang perlu dicek.' } }] }), { status: 200 });
  };
  try {
    await answerOwnerWithGroq({ question: 'Apa yang perlu dicek?', snapshot: { unpaid: 1 } });
    assert.match(requestBody.messages[0].content, /akses baca saja/);
    assert.match(requestBody.messages[0].content, /Jangan mengaku sudah mengubah/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalKey;
  }
});
