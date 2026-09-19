const MENU_CATALOG = [
  { code: 'KSGA', name: 'Kopi Susu Gula Aren', price: 8000, aliases: ['kopi susu gula aren', 'kopi susu aren', 'kopi susu', 'kopi gula aren', 'kopsusren', 'kopsus', 'kopus', 'kosu', 'gula aren', 'gulaaren'] },
  { code: 'LATTE', name: 'Latte', price: 8000, aliases: ['coffee latte', 'kopi latte', 'cafe latte', 'kafe latte', 'latte'] },
  { code: 'AMERICANO', name: 'Americano', price: 8000, aliases: ['americano coffee', 'amerikano', 'americano', 'kopi hitam', 'kopi pahit', 'long black'] },
  { code: 'MATCHA', name: 'Matcha Latte', price: 12000, aliases: ['matcha latte', 'macha', 'matcha', 'green tea', 'greentea'] },
];

const NUMBER_WORDS = { satu:1, sebiji:1, siji:1, dua:2, duwa:2, loro:2, tiga:3, telu:3, empat:4, papat:4, lima:5, limo:5, enam:6, nem:6, tujuh:7, pitu:7, delapan:8, wolu:8, sembilan:9, songo:9, sepuluh:10, sedasa:10 };
const CONFIRM_WORDS = /^(iya|iy|ya|y|oke|ok|gas|gass|jadi|confirm|konfirmasi|bener|benar|sip|siap)(\s|!|\.)*$/i;
const CANCEL_WORDS = /\b(batal|cancel|ga jadi|gajadi|nggak jadi)\b/i;
const VIEW_WORDS = /\b(total|berapa|pesanan gue|order gue|lihat pesanan|cek pesanan)\b/i;

function normalize(text) { return String(text || '').toLowerCase().replace(/[.,;:!?]/g, ' ').replace(/\s+/g, ' ').trim(); }
function isOrderStartText(text) {
  return /\b(?:(?:gua|gue|aku|saya)\s*)?(?:mau|pengen|ingin)\s*(?:mesen|pesen|pesan|order)\b/i.test(String(text || ''));
}
function toQty(token) { const c = String(token || '').toLowerCase().replace(/[^\w]/g, ''); if (/^\d+$/.test(c)) { const n = Number(c); return n > 0 && n <= 100 ? n : null; } return NUMBER_WORDS[c] ?? null; }
function rupiah(n) { return 'Rp' + Number(n || 0).toLocaleString('id-ID'); }
function menuListText(catalog = MENU_CATALOG) { return catalog.map(menu => `• ${menu.name} — ${rupiah(menu.price)}`).join('\n'); }
function emptyOrder() { return { customer_name: null, class_name: null, payment_method: null, items: [], order_status: 'draft', awaiting_confirmation: false }; }

function findMenuAt(words, index, catalog = MENU_CATALOG) {
  const matches = catalog.flatMap(menu => menu.aliases.map(alias => ({ menu, aliasWords: alias.split(/\s+/) }))).sort((a,b) => b.aliasWords.length - a.aliasWords.length);
  return matches.find(match => words.slice(index, index + match.aliasWords.length).join(' ') === match.aliasWords.join(' ')) || null;
}

function extractIce(text) {
  const low = normalize(text);
  if (/\b(no ice|tanpa es|ga pake es|gak pake es|nggak pake es)\b/.test(low)) return 'no_ice';
  if (/\b(less ice|es dikit|es sedikit)\b/.test(low)) return 'less_ice';
  if (/\b(normal ice|ice normal|biasa aja|normal)\b/.test(low)) return 'normal';
  return null;
}

function extractPayment(text) {
  const low = normalize(text);
  if (/\b(qris|qr)\b/.test(low)) return 'qris';
  if (/\b(cash|tunai)\b/.test(low)) return 'cash';
  return null;
}

function extractCustomer(text) {
  const source = String(text || '');
  const explicit = source.match(/\b(?:atas\s+nama|nama(?:\s+(?:gua|gue|aku|saya))?|buat|a\.?\s*n\.?)\b\s*:?\s*([A-Za-z][A-Za-z .']{1,30})/i);
  const compact = source.match(/(?:^|,)\s*([A-Za-z][A-Za-z .']{1,30}?)\s+\d{1,2}[.,]\d{1,2}(?=\s*(?:,|cash|tunai|qris|qr|$))/i);
  const match = explicit || compact;
  if (!match) return null;
  const menuWords = MENU_CATALOG.flatMap(menu => menu.aliases).map(alias => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const stop = new RegExp(`,|\\bkelas\\b|\\bbayar\\b|\\bqris\\b|\\bcash\\b|\\btunai\\b|\\bno ice\\b|\\bless ice\\b|\\btanpa es\\b|\\b(?:bro|bre|woy|woi|paok|bang|admin)\\b|\\b(?:${Object.keys(NUMBER_WORDS).join('|')})\\b|\\b\\d+\\b|\\b(?:${menuWords})\\b`, 'i');
  const name = match[1].split(stop)[0].trim();
  if (/^(nanti|besok|hari ini|lusa|sendiri|sendri|gue|gua|aku|saya)$/i.test(name)) return null;
  return name || null;
}

function extractClass(text) {
  const explicit = String(text || '').match(/kelas\s*:?\s*(\d{1,2}[.,]\d{1,2}|X{1,3}(?:\s+(?:IPA|IPS|Bahasa))?(?:\s+\d{1,2})?|[A-Za-z0-9-]{1,12})/i);
  if (explicit) return explicit[1].trim().replace(',', '.');
  const bare = String(text || '').match(/(?:^|[\s,])(\d{1,2}[.,]\d{1,2}|X{1,3}\s?(?:IPA|IPS|Bahasa)?\s?\d{1,2})(?=[\s,]|$)/i);
  return bare ? bare[1].trim().replace(',', '.') : null;
}

function extractItems(text, catalog = MENU_CATALOG) {
  const words = normalize(text).split(/\s+/).filter(Boolean);
  const items = [];
  for (let i = 0; i < words.length; i++) {
    const match = findMenuAt(words, i, catalog);
    if (!match) continue;
    const parsedQuantity = toQty(words[i - 1]) || toQty(words[i + match.aliasWords.length]);
    const quantity = parsedQuantity || 1;
    const windowText = words.slice(Math.max(0, i - 3), Math.min(words.length, i + match.aliasWords.length + 5)).join(' ');
    const ice = extractIce(windowText);
    items.push({ productCode: match.menu.code, productName: match.menu.name, quantity, quantityConfirmed: Boolean(parsedQuantity), ice, notes: ice === 'less_ice' ? 'less ice' : null, unitPrice: match.menu.price });
    i += match.aliasWords.length - 1;
  }
  const globalIce = extractIce(text);
  if (globalIce && items.length === 1 && !items[0].ice) items[0].ice = globalIce;
  if (items.length === 1 && /\byang satu\b/i.test(text) && items[0].quantity === 2 && globalIce) {
    return [{ ...items[0], quantity: 1, ice: null }, { ...items[0], quantity: 1, ice: globalIce }];
  }
  return items;
}

function missingSlots(order) {
  const missing = [];
  if (!order.items?.length) missing.push('menu');
  if (order.items?.some(item => !item.quantityConfirmed)) missing.push('jumlah');
  if (!order.payment_method) missing.push('pembayaran');
  if (!order.customer_name) missing.push('nama');
  return missing;
}

function summarize(order) {
  if (!order.items?.length) return 'Belum ada item.';
  const lines = order.items.map(item => `• ${item.quantityConfirmed === false ? '' : `${item.quantity}x `}${item.productName}${item.ice ? ` (${item.ice.replace('_',' ')})` : ''}${item.quantityConfirmed === false ? '' : ` — ${rupiah((item.unitPrice || 0) * item.quantity)}`}`);
  const total = order.items.reduce((sum, item) => sum + Number(item.unitPrice || 0) * Number(item.quantity || 0), 0);
  return [...lines, '', `Total: ${rupiah(total)}`, order.payment_method ? `Bayar: ${order.payment_method.toUpperCase()}` : null, order.customer_name ? `Nama: ${order.customer_name}` : null].filter(Boolean).join('\n');
}

function applyMessage(rawText, previousOrder = emptyOrder(), catalog = MENU_CATALOG) {
  const text = String(rawText || '').trim();
  const low = normalize(text);
  const order = { ...emptyOrder(), ...previousOrder, items: [...(previousOrder.items || [])] };
  const parsedItems = extractItems(text, catalog);
  const payment = extractPayment(text);
  const customer = extractCustomer(text);
  const className = extractClass(text);
  const ice = extractIce(text);

  let intent = parsedItems.length ? (/\b(tambah|add)\b/i.test(low) || order.items.length ? 'add_item' : 'create_order') : 'unknown';
  if (CONFIRM_WORDS.test(text)) intent = 'confirm_order';
  else if (CANCEL_WORDS.test(low)) intent = parsedItems.length ? 'remove_item' : 'cancel_order';
  else if (VIEW_WORDS.test(low)) intent = 'view_order';
  else if (/\b(menu|daftar menu|harga)\b/i.test(low)) intent = 'ask_menu';
  else if (/\bjadi\s+/.test(low) && order.items.length === 1) intent = 'update_item';

  if (intent === 'confirm_order') {
    if (order.awaiting_confirmation && !missingSlots(order).length) return { intent, order: { ...order, order_status: 'confirmed' }, reply: null, readyToCommit: true, confidence: 0.95 };
    return { intent: 'unknown', order, reply: 'Belum ada pesanan yang siap dikonfirmasi. Tulis pesanan dulu ya.', readyToCommit: false, confidence: 0.4 };
  }
  if (intent === 'cancel_order') return { intent, order: emptyOrder(), reply: 'Oke, pesanan draft gue batalin.', readyToCommit: false, confidence: 0.9 };
  if (intent === 'remove_item') {
    const codes = new Set(parsedItems.map(item => item.productCode));
    order.items = order.items.filter(item => !codes.has(item.productCode));
  } else if (intent === 'update_item') {
    const qty = low.split(/\s+/).map(toQty).find(Boolean);
    if (qty) order.items = order.items.map((item, index) => index === order.items.length - 1 ? { ...item, quantity: qty } : item);
  } else if (parsedItems.length) {
    const explicitAdd = /\b(tambah|add)\b/i.test(low);
    for (const item of parsedItems) {
      const existingIndex = order.items.findIndex(existing => existing.productCode === item.productCode);
      if (existingIndex < 0) {
        order.items.push(item);
      } else if (explicitAdd && order.items[existingIndex].quantityConfirmed !== false && item.quantityConfirmed !== false) {
        order.items[existingIndex] = {
          ...order.items[existingIndex],
          quantity: Number(order.items[existingIndex].quantity || 0) + Number(item.quantity || 0),
          quantityConfirmed: true,
        };
      } else {
        order.items[existingIndex] = {
          ...order.items[existingIndex],
          ...item,
          ice: item.ice || order.items[existingIndex].ice,
          notes: item.notes || order.items[existingIndex].notes,
        };
      }
    }
  } else if (order.items.length) {
    const qty = low.split(/\s+/).map(toQty).find(Boolean);
    if (qty && order.items.length === 1 && order.items[0].quantityConfirmed === false) {
      order.items = [{ ...order.items[0], quantity: qty, quantityConfirmed: true }];
      intent = 'update_item';
    }
    if (ice) {
      let splitOne = /\byang satu\b/.test(low);
      order.items = order.items.flatMap(item => {
        if (splitOne && item.quantity > 1) { splitOne = false; return [{ ...item, quantity: item.quantity - 1 }, { ...item, quantity: 1, ice }]; }
        return { ...item, ice: item.ice || ice };
      });
    }
  }

  if (payment) order.payment_method = payment;
  if (customer) order.customer_name = customer;
  if (className) order.class_name = className;
  const missing = missingSlots(order);
  order.awaiting_confirmation = missing.length === 0;
  order.order_status = missing.length ? 'collecting_information' : 'ready_to_confirm';

  if (intent === 'ask_menu' || (!parsedItems.length && !payment && !customer && !ice && intent === 'unknown')) return { intent, order, reply: `Menu yang tersedia:\n${menuListText(catalog)}\n\nContoh: “2 kopsus no ice buat Shidqi qris”`, readyToCommit: false, confidence: intent === 'ask_menu' ? 0.9 : 0.45 };
  if (intent === 'view_order') return { intent, order, reply: `Pesanan sementara:\n${summarize(order)}${missing.length ? `\n\nKurang: ${missing.join(', ')}` : '\n\nKalau sudah benar, balas “gas”.'}`, readyToCommit: false, confidence: 0.9 };
  if (missing.length) {
    const ask = missing.includes('menu') ? 'lagi pengin yang creamy, strong, atau yang nggak terlalu manis?' : missing.includes('jumlah') ? 'mau berapa cup?' : missing.includes('pembayaran') ? 'bayarnya cash atau QRIS?' : missing.includes('nama') ? 'atas nama siapa?' : 'mau menu apa?';
    return { intent, order, reply: `Oke sementara:\n${summarize(order)}\n\n${ask}`, readyToCommit: false, confidence: parsedItems.length ? 0.82 : 0.55 };
  }
  return { intent, order, reply: `Jadi pesanannya:\n${summarize(order)}\n\nKalau udah benar, balas “gas” / “iya”.`, readyToCommit: false, confidence: 0.9 };
}

function parseOrderText(rawText, catalog = MENU_CATALOG) {
  const result = applyMessage(rawText, emptyOrder(), catalog);
  return { state: result.order.order_status === 'ready_to_confirm' ? 'DRAFT_READY' : 'INCOMPLETE', missing: missingSlots(result.order), customer: result.order.customer_name, className: result.order.class_name, items: result.order.items, totalQty: result.order.items.reduce((sum, item) => sum + item.quantity, 0), sessionHint: null, notes: null, confidence: result.confidence, reply: result.reply };
}

function buildReplyText(draft) {
  if (draft.reply) return draft.reply;
  if (draft.state === 'INCOMPLETE') return `Menu yang tersedia:\n${menuListText()}\n\nContoh: “2 kopsus no ice buat Shidqi qris”`;
  return `Jadi pesanannya:\n${summarize({ customer_name: draft.customer, class_name: draft.className, payment_method: draft.payment_method, items: draft.items })}\n\nKalau udah benar, balas “gas”.`;
}

export { MENU_CATALOG, menuListText, applyMessage, buildReplyText, emptyOrder, extractIce, extractItems, extractPayment, isOrderStartText, missingSlots, parseOrderText, summarize };
