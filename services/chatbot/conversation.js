function normalize(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,' ').trim();
}

function rupiah(value) {
  return `Rp${Number(value || 0).toLocaleString('id-ID')}`;
}

export function emptyDraft(poSessionId = null) {
  return {
    po_session_id: poSessionId,
    customer_name: null,
    class_name: null,
    payment_method: null,
    items: [],
    pending_question: null,
    last_product_id: null,
    awaiting_confirmation: false,
  };
}

function aliasesFor(product) {
  return [...new Set([product.name,product.code,...(product.chatbot_metadata?.aliases || [])].map(normalize).filter(Boolean))];
}

export function simpleNameAnswer(text,draft,products) {
  if (draft?.pending_question !== 'name') return null;
  let candidate=String(text||'').trim().replace(/[!?.,;:]+$/g,'').trim();
  const explicit=candidate.match(/^(?:nama(?:\s+(?:gua|gue|aku|saya))?|atas\s+nama)\s*:?[ ]*(.+)$/i);
  if (explicit) candidate=explicit[1].trim();
  const classMatch=candidate.match(/(?:^|\s)(?:kelas\s*)?([0-9]{1,2}[.,][0-9]{1,2})(?=\s|$)/i);
  const className=classMatch?classMatch[1].replace(',','.'):null;
  if (classMatch) candidate=candidate.replace(classMatch[0],' ').replace(/\s+/g,' ').trim();
  const normalized=candidate.toLowerCase().replace(/[^a-z ]+/g,' ').replace(/\s+/g,' ').trim();
  if (!normalized||normalized.length<2||normalized.length>40||normalized.split(' ').length>4) return null;
  if (/\b(?:sendiri|sendri|nanti|besok|gue|gua|aku|saya|kamu|dia|kita|mau|pesan|pesen|mesen|order|beli|tambah|kurang|batal|cash|tunai|qris|qr|ice|es|manis|pahit|creamy|strong|iya|ya|gas|oke|ok)\b/.test(normalized)) return null;
  const aliases=(products||[]).flatMap(aliasesFor);
  if (aliases.some(alias=>alias===normalize(candidate))) return null;
  return {intents:className?['PROVIDE_NAME','PROVIDE_CLASS']:['PROVIDE_NAME'],entities:{name:candidate,class_name:className,payment_method:null,item_operations:[]},confidence:1};
}

/**
 * Handles only exact transaction controls whose meaning is unambiguous.
 * Names, corrections, status questions, acknowledgements, ordering, and all
 * other conversational input go through the LLM so the dialogue is not
 * constrained by an ever-growing regex parser.
 */
export function deterministicCustomerTurn(text,draft,products) {
  const raw=String(text||'').trim();
  const value=normalize(raw);
  const base={name:null,class_name:null,payment_method:null,item_operations:[],order_number:null,confirmation:null};
  if (!value) return null;

  if (draft?.awaiting_confirmation&&/^(gas|iya|ya|jadi|lanjut|oke|ok|confirm|konfirmasi)$/.test(value)) {
    return {intents:['CONFIRM_ORDER'],entities:{...base,confirmation:true},reply_hint:null,confidence:1,_source:'FAST_PATH'};
  }
  if (/^(batal|batalin|cancel|gajadi|ga jadi|nggak jadi|tidak jadi)$/.test(value)) {
    return {intents:['CANCEL_ORDER'],entities:base,reply_hint:null,confidence:1,_source:'FAST_PATH'};
  }
  if ((!draft?.payment_method||draft?.pending_question==='payment')&&/^(cash|cas|tunai|qris|qr|keris)(?: aja| ya| dong)?$/.test(value)) {
    return {intents:['SET_PAYMENT_METHOD'],entities:{...base,payment_method:/^(qris|qr|keris)/.test(value)?'QRIS':'CASH'},reply_hint:null,confidence:1,_source:'FAST_PATH'};
  }
  return null;
}

export function resolveProductQuery(query, menu, draft = emptyDraft()) {
  const wanted = normalize(query);
  if (!wanted) return { product: null, ambiguous: [] };
  if (/^(yang (ini|itu|satu|tadi)|item (ini|itu)|terakhir)$/.test(wanted)) {
    const referenced = menu.find(product => product.id === draft.last_product_id)
      || (draft.items.length === 1 ? menu.find(product => product.id === draft.items[0].productId) : null);
    return { product: referenced || null, ambiguous: [] };
  }
  const exact = menu.filter(product => aliasesFor(product).includes(wanted));
  if (exact.length === 1) return { product: exact[0], ambiguous: [] };
  const contained = menu.filter(product => aliasesFor(product).some(alias => wanted.includes(alias) || alias.includes(wanted)));
  if (contained.length === 1) return { product: contained[0], ambiguous: [] };
  return { product: null, ambiguous: (exact.length ? exact : contained).map(product => product.name) };
}

function normalizedModifiers(values) {
  const result = [];
  for (const value of values || []) {
    const modifier = normalize(value);
    if (/^(no ice|tanpa es|ga pake es|gak pake es)$/.test(modifier)) result.push('no_ice');
    else if (/^(less ice|es dikit|es sedikit)$/.test(modifier)) result.push('less_ice');
    else if (/^(less sugar|gula dikit|kurang manis)$/.test(modifier)) result.push('less_sugar');
    else if (modifier) result.push(modifier.replace(/ /g,'_'));
  }
  return [...new Set(result)].slice(0,6);
}

export function applyStructuredPatch(previousDraft, parsed, menu) {
  const draft = { ...emptyDraft(previousDraft?.po_session_id), ...(previousDraft || {}), items: [...(previousDraft?.items || [])] };
  const unresolved = [];
  const ambiguous = [];
  if (parsed?.entities?.name) draft.customer_name = parsed.entities.name.trim();
  if (parsed?.entities?.class_name) draft.class_name = parsed.entities.class_name.trim();
  if (parsed?.entities?.payment_method) draft.payment_method = parsed.entities.payment_method;

  for (const operation of parsed?.entities?.item_operations || []) {
    const resolution = resolveProductQuery(operation.product_query,menu,draft);
    if (!resolution.product) {
      if (resolution.ambiguous.length) ambiguous.push(...resolution.ambiguous);
      else unresolved.push(operation.product_query);
      continue;
    }
    const productId = resolution.product.id;
    const modifiers = normalizedModifiers(operation.modifiers);
    const noIce = modifiers.includes('no_ice');
    const index = draft.items.findIndex(item => item.productId === productId && Boolean(item.noIce) === noIce);
    if (operation.action === 'REMOVE') {
      const targetIndex=draft.items.findIndex(item=>item.productId===productId);
      const removeQuantity=Number(operation.quantity||0);
      if (targetIndex>=0&&removeQuantity>0&&Number(draft.items[targetIndex].quantity)>removeQuantity) {
        draft.items[targetIndex]={...draft.items[targetIndex],quantity:Number(draft.items[targetIndex].quantity)-removeQuantity};
      } else {
        draft.items = draft.items.filter(item => item.productId !== productId);
      }
    } else if (operation.action === 'UPDATE') {
      const targetIndex = index >= 0 ? index : draft.items.findIndex(item => item.productId === productId);
      if (targetIndex >= 0) {
        const target=draft.items[targetIndex];
        const splitQuantity=Number(operation.quantity||0);
        const changesVariant=modifiers.length&&Boolean(target.noIce)!==noIce;
        if (changesVariant&&splitQuantity>0&&Number(target.quantity)>splitQuantity) {
          draft.items[targetIndex]={...target,quantity:Number(target.quantity)-splitQuantity};
          draft.items.push({productId,quantity:splitQuantity,modifiers,noIce,notes:operation.notes||target.notes||null});
        } else {
          draft.items[targetIndex] = {
            ...target,
            ...(operation.quantity ? { quantity: operation.quantity } : {}),
            ...(modifiers.length ? { modifiers, noIce } : {}),
            ...(operation.notes ? { notes: operation.notes } : {}),
          };
        }
      } else {
        unresolved.push(operation.product_query);
      }
    } else if (index >= 0 && operation.quantity) {
      draft.items[index] = { ...draft.items[index], quantity: Number(draft.items[index].quantity || 0)+operation.quantity };
    } else {
      draft.items.push({
        productId,
        quantity: operation.quantity || null,
        modifiers,
        noIce,
        notes: operation.notes || null,
      });
    }
    draft.last_product_id = productId;
  }

  if (parsed?.intents?.includes('CANCEL_ORDER')) return { draft: emptyDraft(draft.po_session_id), cancelled: true, unresolved, ambiguous };
  draft.last_unresolved = unresolved.length ? [...new Set(unresolved)].slice(0,3) : [];
  const missing = missingFields(draft);
  draft.pending_question = missing[0] || null;
  draft.awaiting_confirmation = missing.length === 0;
  return { draft, cancelled: false, unresolved, ambiguous };
}

export function missingFields(draft) {
  const missing = [];
  if (!draft?.items?.length) missing.push('menu');
  else if (draft.items.some(item => !Number.isInteger(item.quantity) || item.quantity <= 0)) missing.push('quantity');
  if (!draft?.customer_name) missing.push('name');
  if (!draft?.payment_method) missing.push('payment');
  return missing;
}

export function draftItemsForRpc(draft) {
  return (draft?.items || []).map(item => ({
    productId: item.productId,
    quantity: Number(item.quantity),
    noIce: Boolean(item.noIce),
    notes: [item.notes,...(item.modifiers || []).filter(value => value !== 'no_ice')].filter(Boolean).join(', ') || null,
  }));
}

export function summarizeDraft(draft, menu) {
  const lines = [];
  let total = 0;
  let hasUnknownQuantity = false;
  for (const item of draft?.items || []) {
    const product = menu.find(candidate => candidate.id === item.productId);
    if (!product) continue;
    const quantity = Number(item.quantity || 0);
    if (!quantity) hasUnknownQuantity = true;
    total += Number(product.price || 0)*quantity;
    const modifiers = (item.modifiers || []).map(value => value.replaceAll('_',' '));
    lines.push(`• ${quantity || '?'}x ${product.name}${modifiers.length ? ` (${modifiers.join(', ')})` : ''} — ${quantity ? rupiah(Number(product.price)*quantity) : 'jumlah belum dipilih'}`);
  }
  return {
    text: [...lines,lines.length&&!hasUnknownQuantity ? `Total: ${rupiah(total)}` : null,draft?.customer_name ? `Nama: ${draft.customer_name}${draft.class_name ? ` · ${draft.class_name}` : ''}` : null,draft?.payment_method ? `Bayar: ${draft.payment_method}` : null].filter(Boolean).join('\n'),
    total,
  };
}

export function menuText(menu, availability = null) {
  const live = availability?.products || [];
  return menu.map(product => {
    const capacity = live.find(item => item.productId === product.id);
    const suffix = capacity && !capacity.available ? ' · habis' : '';
    return `• ${product.name} — ${rupiah(product.price)}${suffix}`;
  }).join('\n');
}

export function groundedRecommendation(text,menu,availability=null) {
  const query=normalize(text);
  const live=availability?.products||[];
  const available=(menu||[]).filter(product=>{
    const capacity=live.find(item=>item.productId===product.id);
    return !capacity||capacity.available!==false;
  });
  const wantsCoffee=/\b(kopi(?:nya)?|coffee)\b/.test(query);
  const wantsCreamy=/\b(creamy|lembut|milky)\b/.test(query);
  const wantsStrong=/\b(strong|kuat|nendang)\b/.test(query);
  const wantsNotBitter=/(?:ga|gak|nggak|tidak|jangan)\s+(?:terlalu\s+)?pahit|kurang\s+pahit/.test(query);
  const wantsNotSweet=/(?:ga|gak|nggak|tidak|jangan)\s+(?:terlalu\s+)?manis|kurang\s+manis/.test(query);
  const wantsSweet=!wantsNotSweet&&/\b(manis|sweet)\b/.test(query);
  const wantsMilk=/\b(susu|milky)\b/.test(query);
  const scored=available.map(product=>{
    const metadata=product.chatbot_metadata||{};
    const tags=(metadata.tags||[]).map(normalize);
    const description=String(metadata.description||'').trim();
    let score=0;
    if (wantsCoffee) score+=tags.includes('kopi')?5:tags.includes('non kopi')?-8:0;
    if (wantsCreamy) score+=tags.includes('creamy')?3:-1;
    if (wantsStrong) score+=tags.includes('strong')?4:-1;
    if (wantsNotBitter) score+=/tidak terlalu pahit|lembut/i.test(description)?4:tags.includes('strong')?-4:tags.includes('creamy')?1:0;
    if (wantsNotSweet) score+=tags.includes('tidak manis')?4:tags.includes('manis')?-3:0;
    if (wantsSweet) score+=tags.includes('manis')?3:tags.includes('tidak manis')?-2:0;
    if (wantsMilk) score+=tags.includes('susu')?3:tags.includes('tanpa susu')?-3:0;
    return {product,description,score};
  }).sort((a,b)=>b.score-a.score||a.product.name.localeCompare(b.product.name));
  const hasPreference=[wantsCoffee,wantsCreamy,wantsStrong,wantsNotBitter,wantsNotSweet,wantsSweet,wantsMilk].some(Boolean);
  const picks=scored.filter(item=>!hasPreference||item.score>0).slice(0,2);
  if (!picks.length) return 'Menu yang cocok dengan selera itu belum tersedia sekarang. Mau lihat menu yang masih bisa dipesan?';
  if (!hasPreference) {
    const first=picks[0];
    return `Kalau mau yang aman, coba ${first.product.name}. ${first.description}`.trim();
  }
  return picks.map((item,index)=>`${index===0?'Paling cocok':'Alternatifnya'} ${item.product.name}${item.description?` — ${item.description}`:''}`).join('\n');
}

export function nextReply(draft,menu,{ unresolved=[],ambiguous=[],cancelled=false }={}) {
  if (cancelled) return 'Oke, draft pesanannya dibatalkan.';
  if (ambiguous.length) return `Yang kamu maksud ${[...new Set(ambiguous)].join(' atau ')}?`;
  if (unresolved.length) {
    const saved=summarizeDraft(draft,menu).text;
    return `${saved?`Yang sudah kusimpan:\n${saved}\n\n`:''}“${unresolved[0]}” belum tersedia di menu sekarang, jadi belum kutambahkan. Yang ada:\n${menuText(menu)}\n\nMau ganti dengan menu yang mana?`;
  }
  const missing = missingFields(draft);
  if (missing[0] === 'menu') return `Boleh, mau pesan apa? Ini menunya ya:\n${menuText(menu)}`;
  const summary = summarizeDraft(draft,menu).text;
  if (missing[0] === 'quantity') return `${summary}\n\nMau berapa cup?`;
  if (missing[0] === 'name') return `${summary}\n\nAtas nama siapa?`;
  if (missing[0] === 'payment') return `${summary}\n\nBayarnya cash atau QRIS?`;
  return `Jadi pesanannya:\n${summary}\n\nKalau sudah benar, balas “gas” atau “iya”.`;
}
