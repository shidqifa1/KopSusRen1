import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseWithGroq } from '../services/parser/groqOrderParser.js';

// Mock mode exercises scripted provider responses through the real parser.
// It does not measure whether Groq understands the input language.
export async function evaluateParserCases(data, { mode = 'mock' } = {}) {
  if (!['mock', 'live'].includes(mode)) throw new Error('Mode must be mock or live');
  if (mode === 'live' && !process.env.GROQ_API_KEY) throw new Error('Live mode requires GROQ_API_KEY');
  const menu = data.products.map(product => ({ ...product, id: `eval:${product.code}`, chatbot_metadata: { aliases: product.aliases || [] } }));
  const cases = [...data.cases, ...(data.real_customer_messages?.cases || [])];
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GROQ_API_KEY;
  const results = [];
  const ids = new Set();
  try {
    if (mode === 'mock') process.env.GROQ_API_KEY = 'parser-slice1-mock-key';
    for (const entry of cases) {
      assert.ok(entry.id && !ids.has(entry.id), `Missing or duplicate id: ${entry.id}`);
      ids.add(entry.id);
      if (mode === 'live' && entry.mock_only) {
        results.push({ id: entry.id, skipped: true, reason: 'scripted malformed provider output' });
        continue;
      }
      for (const [index, turn] of entry.turns.entries()) {
        let calls = 0;
        assert.equal(typeof turn.input, 'string');
        if (mode === 'mock') globalThis.fetch = async () => {
          const response = turn.mock_sequence?.[calls++];
          assert.ok(response, `Unscripted provider request: ${entry.id}`);
          if (response.status && response.status !== 200) return new Response(response.content || '', { status: response.status });
          return new Response(JSON.stringify({ model: 'scripted-mock', choices: [{ message: {
            content: response.content ?? JSON.stringify(response.output),
          } }] }), { status: 200 });
        };
        else if (results.length) await new Promise(resolve => setTimeout(resolve, 750));
        try {
          const parsed = await parseWithGroq({ text: turn.input, menu, currentOrder: turn.currentOrder || {}, role: 'CUSTOMER', history: turn.history || [],
            evaluationPolicy: mode === 'live' ? { maxPrimaryAttempts: 3, maxFallbackAttempts: 2 } : null,
          });
          const compare = (actual, expected, location = '') => {
            if (Array.isArray(expected)) {
              assert.ok(Array.isArray(actual), `${location} must be an array`);
              assert.equal(actual.length, expected.length, `${location}.length`);
              expected.forEach((value, i) => compare(actual[i], value, `${location}[${i}]`));
            } else if (expected !== null && typeof expected === 'object') {
              for (const [key, value] of Object.entries(expected)) compare(actual?.[key], value, `${location}.${key}`);
            } else {
              if (location.endsWith('.product_query') && menu.some(product => product.code === expected)) {
                const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
                const matches = menu.filter(product => [product.code, product.name, ...product.chatbot_metadata.aliases].some(alias => normalize(alias) === normalize(actual)));
                assert.equal(matches.length, 1, `${location} must resolve uniquely`);
                actual = matches[0].code;
              }
              assert.deepEqual(actual, expected, location);
            }
          };
          compare(parsed, turn.expected);
          results.push({ id: entry.id, turn: index + 1, passed: true, calls: mode === 'mock' ? calls : parsed?._diagnostics?.attempts?.length ?? 0 });
        } catch (error) {
          // Do not print live provider payloads or real customer messages.
          results.push({ id: entry.id, turn: index + 1, passed: false, error: error.code === 'ERR_ASSERTION' ? String(error.message).split('\n')[0] : error.category || 'PARSER_ERROR' });
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalKey;
  }
  return { mode, passed: results.filter(row => row.passed).length, failed: results.filter(row => row.passed === false).length, skipped: results.filter(row => row.skipped).length, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = new Map(process.argv.slice(2).map(value => value.replace(/^--/, '').split('=')));
  const mode = args.get('mode') || 'mock';
  const data = JSON.parse(await readFile(args.get('dataset') || new URL('./parser-slice1-cases.json', import.meta.url), 'utf8'));
  const report = await evaluateParserCases(data, { mode });
  console.log(`Parser Slice 1 [${mode.toUpperCase()}]: ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`);
  if (mode === 'mock') console.log('Scripted Groq responses: validates parser plumbing and safety, not live language accuracy.');
  for (const row of report.results.filter(row => row.passed === false)) console.log(`FAIL ${row.id} turn ${row.turn}: ${row.error}`);
  if (mode === 'mock') console.log('LIVE: NOT RUN (use --mode=live with GROQ_API_KEY).');
  process.exitCode = report.failed ? 1 : 0;
}
