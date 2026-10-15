import { SAFETY_CLASSIFICATION,applyParserAmbiguities,applyStructuredPatch,classifyDraftSafety,emptyDraft } from './conversation.js';

function normalizeInput(text,parsed) {
  let normalized=String(text||'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim().slice(0,600);
  normalized=normalized.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[email]').replace(/(?:\+?62|0)\d{8,13}/g,'[phone]');
  for (const value of [parsed?.entities?.name,parsed?.entities?.class_name]) {
    const sensitive=String(value||'').normalize('NFKC').toLowerCase().trim();
    if (sensitive.length>=2) normalized=normalized.split(sensitive).join(value===parsed?.entities?.name?'[name]':'[class]');
  }
  return normalized;
}

function sanitizedParserResult(parsed) {
  if (!parsed) return null;
  return {
    intents:[...(parsed.intents||[])],
    entities:{
      payment_method:parsed.entities?.payment_method||null,
      item_operations:(parsed.entities?.item_operations||[]).map(item=>({
        action:item.action,product_query:String(item.product_query||'').slice(0,120),
        quantity:item.quantity??null,modifiers:[...(item.modifiers||[])],
      })),
    },
    confidence:Number(parsed.confidence||0),
    needs_clarification:Boolean(parsed.needs_clarification),
    ambiguities:[...(parsed.ambiguities||[])].slice(0,10),
  };
}

export function buildShadowObservation({text,prepared}) {
  const products=prepared?.products||[];
  const previous={...emptyDraft(prepared?.previousDraft?.po_session_id||null),...(prepared?.previousDraft||{}),items:[...(prepared?.previousDraft?.items||[])]};
  const parsed=prepared?.parsed||null;
  let patchResult;
  if (parsed) {
    patchResult=applyParserAmbiguities(applyStructuredPatch(previous,parsed,products),parsed);
  } else {
    patchResult={draft:previous,unresolved:[],ambiguous:[],invalidModifiers:[],parserFailed:true};
  }
  const safety=classifyDraftSafety(patchResult.draft,patchResult);
  const resolvedItems=(safety.draft.items||[]).map(item=>{
    const product=products.find(candidate=>candidate.id===item.productId);
    return {
      productCode:product?.code||null,
      quantity:Number(item.quantity||0)||null,
      modifiers:[...(item.modifiers||[])],
    };
  }).filter(item=>item.productCode);
  return {
    normalizedInput:normalizeInput(text,parsed),
    parserIntents:[...(parsed?.intents||[])],
    resolvedItems,
    unresolvedEntities:[...(patchResult.unresolved||[])],
    ambiguities:[...new Set([...(patchResult.ambiguous||[]),...(patchResult.invalidModifiers||[])])].slice(0,10),
    safetyClassification:safety.classification,
    clarificationReason:(safety.issues||[]).join('; ')||null,
    parserFailed:!parsed,
    parserLatencyMs:Math.max(0,Math.round(Number(prepared?.parserLatencyMs||0))),
    parserProvider:prepared?.parsedByAi?'GROQ':parsed?'DETERMINISTIC':'NONE',
    parserModel:parsed?._model||null,
    wouldBeSafe:safety.classification===SAFETY_CLASSIFICATION.SAFE&&!(safety.issues||[]).length,
    parserResult:sanitizedParserResult(parsed),
  };
}
