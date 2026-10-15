function normalize(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,' ').trim();
}

export const SAFETY_CLASSIFICATION = Object.freeze({
  SAFE: 'SAFE',
  NEEDS_CLARIFICATION: 'NEEDS_CLARIFICATION',
  OWNER_HANDOFF: 'OWNER_HANDOFF',
});

export const VALIDATED_MODIFIERS = Object.freeze(['NO_ICE','LESS_ICE','LESS_SWEET']);

const MODIFIER_ALIASES = new Map([
  ['no ice','NO_ICE'],
  ['tanpa es','NO_ICE'],
  ['ga pake es','NO_ICE'],
  ['gak pake es','NO_ICE'],
  ['nggak pake es','NO_ICE'],
  ['less ice','LESS_ICE'],
  ['es dikit','LESS_ICE'],
  ['es sedikit','LESS_ICE'],
  ['less sweet','LESS_SWEET'],
  ['less sugar','LESS_SWEET'],
  ['kurang manis','LESS_SWEET'],
  ['gula dikit','LESS_SWEET'],
]);

const EXPLICIT_CONFIRMATIONS = new Set([
  'ya',
  'iya',
  'gas',
  'konfirmasi',
  'konfirmasi pesanan',
  'pesanan benar',
  'sudah benar',
]);

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
    _clarification_attempts: 0,
  };
}

function aliasesFor(product) {
  return [...new Set([product.name,product.code,...(product.chatbot_metadata?.aliases || [])].map(normalize).filter(Boolean))];
}

function compactAlias(value) {
  return normalize(value).replace(/\s+/g,'');
}

function normalizedModifierSet(values,item=null) {
  const modifiers=[...(values||[])];
  if (item?.noIce&&!modifiers.some(value=>normalize(value)==='no ice')) modifiers.push('NO_ICE');
  return [...new Set(modifiers.map(value=>MODIFIER_ALIASES.get(normalize(value))||String(value).trim().toUpperCase())
    .filter(value=>VALIDATED_MODIFIERS.includes(value)))].sort();
}

function variantKey(productId,modifiers,item=null) {
  return `${productId}:${normalizedModifierSet(modifiers,item).join('|')}`;
}

function mergeVariant(items,candidate) {
  const key=variantKey(candidate.productId,candidate.modifiers,candidate);
  const index=items.findIndex(item=>variantKey(item.productId,item.modifiers,item)===key);
  if (index<0) return [...items,candidate];
  const merged=[...items];
  const existingQuantity=Number.isInteger(merged[index].quantity)?Number(merged[index].quantity):null;
  const addedQuantity=Number.isInteger(candidate.quantity)?Number(candidate.quantity):null;
  const quantity=existingQuantity===null?addedQuantity:addedQuantity===null?existingQuantity:existingQuantity+addedQuantity;
  merged[index]={...merged[index],quantity,notes:candidate.notes||merged[index].notes||null};
  return merged;
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
 * Handles unambiguous controls and short openings without product entities.
 * Item extraction and other conversational input remain with the LLM.
 */
export function deterministicCustomerTurn(text,draft,products) {
  const raw=String(text||'').trim();
  const value=normalize(raw);
  const base={name:null,class_name:null,payment_method:null,item_operations:[],order_number:null,confirmation:null};
  if (!value) return null;

  if (isExplicitOrderConfirmation(text,draft)) {
    return {intents:['CONFIRM_ORDER'],entities:{...base,confirmation:true},reply_hint:null,confidence:1,_source:'FAST_PATH'};
  }
  if (/^(batal|batalin|cancel|gajadi|ga jadi|nggak jadi|tidak jadi)$/.test(value)) {
    return {intents:['CANCEL_ORDER'],entities:base,reply_hint:null,confidence:1,_source:'FAST_PATH'};
  }
  if (/^(?:(?:mau|pengen|ingin) )?(?:pesan|pesen|mesen|order)(?: (?:dong|dongs|mas|mass|bang|bro|ya|nih|deh))*$/.test(value)) {
    return {intents:['START_ORDER'],entities:base,reply_hint:null,confidence:1,_source:'FAST_PATH'};
  }
  if (/^(?:kapan|jam berapa)(?: kira kira)?(?: (?:po|tokonya))? (?:buka|bukanya)(?: ya| dong)?$/.test(value)) {
    return {intents:['CHECK_PO_STATUS'],entities:base,reply_hint:null,confidence:1,_source:'FAST_PATH'};
  }
  if ((!draft?.payment_method||draft?.pending_question==='payment')&&/^(cash|cas|tunai|qris{1,3}|qr|keris)(?: aja| ya| dong)?$/.test(value)) {
    return {intents:['SET_PAYMENT_METHOD'],entities:{...base,payment_method:/^(qris{1,3}|qr|keris)/.test(value)?'QRIS':'CASH'},reply_hint:null,confidence:1,_source:'FAST_PATH'};
  }
  return null;
}

export function isExplicitOrderConfirmation(text,draft) {
  return Boolean(draft?.awaiting_confirmation) && EXPLICIT_CONFIRMATIONS.has(normalize(text));
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
  const compactWanted=compactAlias(wanted);
  const compactExact=compactWanted.length>=4
    ? menu.filter(product=>aliasesFor(product).some(alias=>compactAlias(alias)===compactWanted))
    : [];
  if (compactExact.length===1) return {product:compactExact[0],ambiguous:[]};
  const contained = menu.filter(product => aliasesFor(product).some(alias => wanted.includes(alias) || alias.includes(wanted)));
  if (contained.length === 1) return { product: contained[0], ambiguous: [] };
  return { product: null, ambiguous: (exact.length ? exact : contained).map(product => product.name) };
}

function validatedModifiers(values) {
  const valid = [];
  const invalid = [];
  for (const value of values || []) {
    const modifier = normalize(value);
    const canonical = MODIFIER_ALIASES.get(modifier);
    if (canonical) valid.push(canonical);
    else if (modifier) invalid.push(String(value).trim().slice(0,80));
  }
  return {
    valid: [...new Set(valid)].slice(0,6),
    invalid: [...new Set(invalid)].slice(0,6),
  };
}

export function applyStructuredPatch(previousDraft, parsed, menu) {
  const draft = { ...emptyDraft(previousDraft?.po_session_id), ...(previousDraft || {}), items: [...(previousDraft?.items || [])] };
  const hasItemOperations = Boolean(parsed?.entities?.item_operations?.length);
  const unresolved = [];
  const ambiguous = [];
  const invalidModifiers = [];
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
    const modifierValidation = validatedModifiers(operation.modifiers);
    const modifiers = modifierValidation.valid;
    invalidModifiers.push(...modifierValidation.invalid);
    const noIce = modifiers.includes('NO_ICE');
    const desiredKey=variantKey(productId,modifiers,{noIce});
    const index = draft.items.findIndex(item => variantKey(item.productId,item.modifiers,item)===desiredKey);
    if (operation.action === 'REMOVE') {
      const candidates=draft.items.filter(item=>item.productId===productId);
      if (!modifiers.length&&candidates.length>1) {
        ambiguous.push(`Varian ${resolution.product.name} yang ingin dikurangi`);
        continue;
      }
      const targetIndex=modifiers.length?index:draft.items.findIndex(item=>item.productId===productId);
      if (targetIndex<0) {
        unresolved.push(operation.product_query);
        continue;
      }
      const removeQuantity=Number(operation.quantity||0);
      if (targetIndex>=0&&removeQuantity>0&&Number(draft.items[targetIndex].quantity)>removeQuantity) {
        draft.items[targetIndex]={...draft.items[targetIndex],quantity:Number(draft.items[targetIndex].quantity)-removeQuantity};
      } else {
        draft.items.splice(targetIndex,1);
      }
    } else if (operation.action === 'UPDATE') {
      const candidates=draft.items.filter(item=>item.productId===productId);
      if (candidates.length>1&&(!modifiers.length||index<0)) {
        ambiguous.push(`Varian ${resolution.product.name} yang ingin diubah`);
        continue;
      }
      const targetIndex = index >= 0 ? index : draft.items.findIndex(item => item.productId === productId);
      if (targetIndex >= 0) {
        const target=draft.items[targetIndex];
        const splitQuantity=Number(operation.quantity||0);
        const changesVariant=modifiers.length&&variantKey(target.productId,target.modifiers,target)!==desiredKey;
        if (changesVariant&&splitQuantity>0&&Number(target.quantity)>splitQuantity) {
          draft.items[targetIndex]={...target,quantity:Number(target.quantity)-splitQuantity};
          draft.items=mergeVariant(draft.items,{productId,quantity:splitQuantity,modifiers,noIce,notes:operation.notes||target.notes||null});
        } else {
          const updated = {
            ...target,
            ...(operation.quantity ? { quantity: operation.quantity } : {}),
            ...(modifiers.length ? { modifiers, noIce } : {}),
            ...(operation.notes ? { notes: operation.notes } : {}),
          };
          draft.items.splice(targetIndex,1);
          draft.items=mergeVariant(draft.items,updated);
        }
      } else {
        unresolved.push(operation.product_query);
      }
    } else if (index >= 0 && operation.quantity) {
      draft.items[index] = { ...draft.items[index], quantity: Number(draft.items[index].quantity || 0)+operation.quantity };
    } else {
      draft.items=mergeVariant(draft.items,{
        productId,
        quantity: operation.quantity || null,
        modifiers,
        noIce,
        notes: operation.notes || null,
      });
    }
    draft.last_product_id = productId;
  }

  if (parsed?.intents?.includes('CANCEL_ORDER')) return { draft: emptyDraft(draft.po_session_id), cancelled: true, unresolved, ambiguous, invalidModifiers };
  const effectiveUnresolved=unresolved.length
    ? [...new Set(unresolved)].slice(0,3)
    : (hasItemOperations?[]:[...(previousDraft?.last_unresolved||[])]);
  const effectiveAmbiguous=ambiguous.length
    ? [...new Set(ambiguous)].slice(0,3)
    : (hasItemOperations?[]:[...(previousDraft?.last_ambiguities||[])]);
  const effectiveInvalidModifiers=invalidModifiers.length
    ? [...new Set(invalidModifiers)].slice(0,3)
    : (hasItemOperations?[]:[...(previousDraft?.invalid_modifiers||[])]);
  draft.last_unresolved = effectiveUnresolved;
  draft.last_ambiguities = effectiveAmbiguous;
  draft.invalid_modifiers = effectiveInvalidModifiers;
  const missing = missingFields(draft);
  draft.pending_question = missing[0] || null;
  draft.awaiting_confirmation = missing.length === 0;
  return {
    draft,
    cancelled: false,
    unresolved:effectiveUnresolved,
    ambiguous:effectiveAmbiguous,
    invalidModifiers:effectiveInvalidModifiers,
  };
}

export function mentionsSupportedPaymentMethod(text) {
  return /\b(?:cash|cas|tunai|qris{1,3}|qr|keris)\b/i.test(String(text||''));
}

const MODIFIER_TEXT_PATTERN='(?:no[ -]?ice|tanpa es|ga(?:k|k)? pake es|nggak pake es|less[ -]?ice|es (?:dikit|sedikit)|less[ -]?(?:sweet|sugar)|kurang manis|gula dikit)';
const QUANTITY_WORDS=Object.freeze({satu:1,se:1,dua:2,tiga:3,empat:4,lima:5});

function explicitTotalForRepeatedProduct(raw,operations) {
  if (operations.length<2||new Set(operations.map(operation=>normalize(operation.product_query))).size!==1) return null;
  const product=normalize(operations[0].product_query);
  if (!product) return null;
  const productPattern=product.split(' ').join(String.raw`\s+`);
  const match=new RegExp(String.raw`\b(\d+|satu|dua|tiga|empat|lima)\s+${productPattern}\b`,'i').exec(normalize(raw));
  if (!match) return null;
  return /^\d+$/.test(match[1])?Number(match[1]):QUANTITY_WORDS[match[1].toLowerCase()]||null;
}

/**
 * Adds only fail-closed, deterministic signals for business-critical wording
 * that the model must not resolve on its own. It may remove an ambiguously
 * scoped modifier, but never adds an item, modifier, payment, or confirmation.
 */
export function applyDeterministicCustomerSafetyGuards(text,parsed) {
  if (!parsed) return null;
  const raw=String(text||'').trim();
  const normalized=normalize(raw);
  const operations=(parsed.entities?.item_operations||[]).map(operation=>({
    ...operation,modifiers:[...(operation.modifiers||[])],
  }));
  const reasons=[];

  // In a multi-item sentence a trailing "item quantity modifier" construction
  // does not prove whether the suffix applies only to the nearest item or the
  // whole cart. Prefix/infix scopes such as "matcha 2 no ice sama aren 1" and
  // single-item phrases remain untouched.
  const trailingModifier=new RegExp(String.raw`\b(?:\d+|satu|dua|tiga|empat|lima)\s+(${MODIFIER_TEXT_PATTERN})\s*$`,'i').exec(raw);
  const modifierMentions=raw.match(new RegExp(String.raw`\b${MODIFIER_TEXT_PATTERN}\b`,'gi'))||[];
  const explicitTotal=explicitTotalForRepeatedProduct(raw,operations);
  if (explicitTotal!==null&&!/\b(?:tambah|tambahkan|plus)\b/i.test(raw)) {
    const plain=operations.filter(operation=>!normalizedModifierSet(operation.modifiers).length);
    const modified=operations.filter(operation=>normalizedModifierSet(operation.modifiers).length);
    const modifiedTotal=modified.reduce((total,operation)=>total+(Number.isInteger(operation.quantity)?operation.quantity:0),0);
    if (plain.length===1&&modified.length&&plain[0].quantity===explicitTotal&&modifiedTotal>0&&modifiedTotal<explicitTotal) {
      plain[0].quantity=explicitTotal-modifiedTotal;
    }
  }
  const operationTotal=operations.reduce((total,operation)=>total+(Number.isInteger(operation.quantity)?operation.quantity:0),0);
  const provenSplit=explicitTotal!==null&&operationTotal===explicitTotal;
  if (operations.length>1&&modifierMentions.length===1&&trailingModifier&&!provenSplit) {
    const canonical=MODIFIER_ALIASES.get(normalize(trailingModifier[1]));
    if (canonical&&operations.some(operation=>normalizedModifierSet(operation.modifiers).includes(canonical))) {
      for (const operation of operations) {
        operation.modifiers=operation.modifiers.filter(value=>!normalizedModifierSet([value]).includes(canonical));
      }
      reasons.push(`Scope modifier ${canonical} pada beberapa item belum jelas`);
    }
  }

  if (/\b(?:paypal|pay pal|gopay|ovo|dana|shopee ?pay|transfer bank)\b/i.test(raw)) {
    reasons.push('Metode pembayaran yang diminta belum didukung');
  }
  if (/\b(?:utang|ngutang|bon|bayar nanti|pay later|paylater|tempo)\b/i.test(raw)) {
    reasons.push('Pembayaran kredit atau bayar nanti belum didukung');
  }
  if (/\b(?:antar|kirim|delivery|gojek|grab)\b.{0,50}\b(?:ke|alamat|rumah|sekolah|kantor)\b/i.test(raw)) {
    reasons.push('Permintaan pengantaran belum didukung oleh alur pemesanan');
  }
  if ((operations.length||/\b(?:pesan|pesen|order|beli|kopsus|matcha|latte|americano|aren)\b/i.test(raw))
    && /\b(?:mungkin|kayaknya|belum yakin|masih mikir|barangkali)\b/i.test(raw)) {
    reasons.push('Pesanan atau jumlah masih dinyatakan tidak pasti');
  }
  if (/(?:anggap|asumsikan).{0,45}(?:stok|stock|harga|payment|pembayaran|validasi).{0,30}(?:cukup|lunas|valid|aman)|(?:abaikan|lewati|bypass).{0,45}(?:stok|stock|harga|payment|pembayaran|validasi|aturan)|(?:paksa|langsung).{0,20}(?:confirm|konfirmasi)/i.test(raw)) {
    reasons.push('Instruksi untuk melewati aturan bisnis tidak dapat diterapkan');
  }
  if (!reasons.length) return {...parsed,entities:{...parsed.entities,item_operations:operations}};
  return {
    ...parsed,
    entities:{...parsed.entities,item_operations:operations},
    needs_clarification:true,
    ambiguities:[...new Set([...(parsed.ambiguities||[]),...reasons])].slice(0,6),
    _deterministic_safety_reasons:reasons,
  };
}

export function sanitizeCustomerParsedResult(text,previousDraft,parsed) {
  if (!parsed) return null;
  let sanitized=parsed;
  if (sanitized.intents?.includes('CONFIRM_ORDER')&&!isExplicitOrderConfirmation(text,previousDraft)) {
    sanitized={...sanitized,intents:sanitized.intents.filter(intent=>intent!=='CONFIRM_ORDER')};
  }
  if (sanitized.entities?.payment_method&&!mentionsSupportedPaymentMethod(text)) {
    sanitized={
      ...sanitized,
      intents:(sanitized.intents||[]).filter(intent=>intent!=='SET_PAYMENT_METHOD'),
      entities:{...sanitized.entities,payment_method:null},
    };
  }
  return applyDeterministicCustomerSafetyGuards(text,sanitized);
}

export function applyParserAmbiguities(patchResult,parsed) {
  const modelAmbiguities=[...(parsed?.ambiguities||[])];
  if (parsed?.needs_clarification&&!modelAmbiguities.length) modelAmbiguities.push('Pesan masih memiliki tafsir yang belum pasti');
  if (!modelAmbiguities.length) return patchResult;
  const ambiguous=[...new Set([...(patchResult.ambiguous||[]),...modelAmbiguities])].slice(0,6);
  return {...patchResult,ambiguous,draft:{...patchResult.draft,last_ambiguities:ambiguous}};
}

export function classifyDraftSafety(draft,{ unresolved=[],ambiguous=[],invalidModifiers=[],parserFailed=false }={}) {
  const issues = [
    ...unresolved.map(value=>`Produk tidak dikenali: ${value}`),
    ...ambiguous.map(value=>`Produk ambigu: ${value}`),
    ...invalidModifiers.map(value=>`Modifier tidak didukung: ${value}`),
    ...(parserFailed?['Parser tidak tersedia atau gagal memahami pesan']:[]),
  ];
  const hasSafetyIssue=issues.length>0;
  const clarificationAttempts=hasSafetyIssue
    ? Math.min(Number(draft?._clarification_attempts||0)+1,2)
    : 0;
  const missing=missingFields(draft);
  const classification=hasSafetyIssue
    ? (clarificationAttempts>=2?SAFETY_CLASSIFICATION.OWNER_HANDOFF:SAFETY_CLASSIFICATION.NEEDS_CLARIFICATION)
    : (missing.length?SAFETY_CLASSIFICATION.NEEDS_CLARIFICATION:SAFETY_CLASSIFICATION.SAFE);
  return {
    classification,
    clarificationAttempts,
    issues,
    missing,
    draft:{
      ...draft,
      awaiting_confirmation:hasSafetyIssue?false:Boolean(draft?.awaiting_confirmation),
      _clarification_attempts:clarificationAttempts,
      ...(hasSafetyIssue?{}:{_handoff_notified:false}),
    },
  };
}

export function authorizeOrderCommit({text,previousDraft,safety}) {
  return isExplicitOrderConfirmation(text,previousDraft)
    && safety?.classification===SAFETY_CLASSIFICATION.SAFE
    && !safety.issues?.length
    && !safety.missing?.length;
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
    notes: [
      item.notes,
      ...(item.modifiers || [])
        .filter(value => value !== 'NO_ICE' && value !== 'no_ice')
        .map(value => String(value).toLowerCase().replaceAll('_',' ')),
    ].filter(Boolean).join(', ') || null,
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
    const modifiers = (item.modifiers || []).map(value => value.toLowerCase().replaceAll('_',' '));
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

export function nextReply(draft,menu,{ unresolved=[],ambiguous=[],invalidModifiers=[],cancelled=false }={}) {
  if (cancelled) return 'Oke, draft pesanannya dibatalkan.';
  const summary = summarizeDraft(draft,menu).text;
  const context = summary ? `Pesanan sementara:\n${summary}\n\n` : '';
  if (unresolved.length) {
    return `${context}“${unresolved[0]}” belum tersedia di menu sekarang, jadi belum kutambahkan. Yang ada:\n${menuText(menu)}\n\nMau ganti dengan menu yang mana?`;
  }
  if (invalidModifiers.length) {
    return `${context}Untuk catatannya, pilih tanpa es, es sedikit, atau kurang manis ya. Mau yang mana?`;
  }
  const missing = missingFields(draft);
  const quantityMenus = [...new Set((draft?.items||[])
    .filter(item=>!Number.isInteger(item.quantity)||item.quantity<=0)
    .map(item=>menu.find(product=>product.id===item.productId)?.name).filter(Boolean))];
  const quantityQuestion = quantityMenus.length>1
    ? `Masing-masing mau berapa cup untuk ${quantityMenus.join(' dan ')}?`
    : `Mau berapa cup${quantityMenus.length?` ${quantityMenus[0]}`:''}?`;
  if (ambiguous.length) {
    const choices = [...new Set(menu.filter(product=>ambiguous.includes(product.name)).map(product=>product.name))];
    if (choices.length) return `${context}Maksudnya ${choices.join(' atau ')}?`;
    if (ambiguous.some(value=>/modifier|varian/i.test(value))) {
      const detail = ambiguous.some(value=>/NO_ICE|no ice|tanpa es/i.test(value)) ? 'tanpa es'
        : ambiguous.some(value=>/LESS_ICE|less ice/i.test(value)) ? 'es sedikit'
        : ambiguous.some(value=>/LESS_SWEET|less sweet/i.test(value)) ? 'kurang manis' : null;
      return `${context}${detail?`Yang ${detail} itu`:'Catatan itu'} untuk minuman yang mana, dan berapa cup?`;
    }
    if (missing[0]==='quantity'&&ambiguous.some(value=>/jumlah|quantity|kuantitas/i.test(value))) {
      return `${context}${quantityQuestion}`;
    }
    return `${context}Aku belum yakin maksud pesan terakhir. Bisa jelasin lagi bagian yang mau dipesan atau diubah?`;
  }
  if (missing[0] === 'menu') return `Boleh, mau pesan apa? Ini menunya ya:\n${menuText(menu)}`;
  if (missing[0] === 'quantity') return `${summary}\n\n${quantityQuestion}`;
  if (missing[0] === 'name') return `${summary}\n\nAtas nama siapa?`;
  if (missing[0] === 'payment') return `${summary}\n\nBayarnya cash atau QRIS?`;
  return `Jadi pesanannya:\n${summary}\n\nKalau sudah benar, balas “gas” atau “iya”.`;
}
