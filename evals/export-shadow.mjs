import { createHash } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';

function argsMap(values) {
  return new Map(values.map(value=>value.startsWith('--')?value.slice(2).split('='):[value,true]));
}

function asArray(value) { return Array.isArray(value)?value:[]; }

export function buildLabelingExport(rows,{exportedAt=new Date().toISOString()}={}) {
  if (!Array.isArray(rows)) throw new Error('Shadow input harus berupa JSON array');
  return {
    schemaVersion:1,
    exportedAt,
    warning:'Parser prediction is not ground truth. A human must fill humanLabel before promotion to an eval case.',
    count:rows.length,
    summary:{
      safe:rows.filter(row=>row.safety_classification==='SAFE').length,
      clarification:rows.filter(row=>row.safety_classification==='NEEDS_CLARIFICATION').length,
      handoff:rows.filter(row=>row.safety_classification==='OWNER_HANDOFF').length,
      parserFailures:rows.filter(row=>Boolean(row.parser_failed)).length,
    },
    candidates:rows.map((row,index)=>({
      candidateId:`shadow-${createHash('sha256').update(String(row.id||row.wa_message_id||index)).digest('hex').slice(0,16)}`,
      observedAt:row.observed_at||row.source_message_created_at||null,
      input:String(row.normalized_input||'').slice(0,600),
      prediction:{
        intents:asArray(row.parser_intents),
        items:asArray(row.resolved_items),
        unresolvedEntities:asArray(row.unresolved_entities),
        ambiguities:asArray(row.ambiguities),
        safety:row.safety_classification||null,
        clarificationReason:row.clarification_reason||null,
        parserFailed:Boolean(row.parser_failed),
        provider:row.parser_provider||null,
        model:row.parser_model||null,
      },
      humanLabel:null,
      reviewerNotes:null,
    })),
  };
}

async function loadRows(args) {
  if (args.get('input')) return JSON.parse(await readFile(path.resolve(args.get('input')),'utf8'));
  if (!args.has('from-db')) throw new Error('Gunakan --input=<file> atau flag eksplisit --from-db');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL diperlukan untuk --from-db');
  const limit=Math.max(1,Math.min(5000,Number(args.get('limit')||500)));
  const { default:postgres }=await import('postgres');
  const db=postgres(process.env.DATABASE_URL,{max:1,idle_timeout:2,connect_timeout:10});
  try {
    return await db`select id,observed_at,source_message_created_at,normalized_input,parser_intents,
      resolved_items,unresolved_entities,ambiguities,safety_classification,clarification_reason,
      parser_failed,parser_provider,parser_model
      from chat_shadow_observations order by observed_at desc limit ${limit}`;
  } finally { await db.end(); }
}

if (process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)) {
  const args=argsMap(process.argv.slice(2));
  const output=path.resolve(args.get('output')||'evals/shadow-labeling.json');
  const result=buildLabelingExport(await loadRows(args));
  await writeFile(output,`${JSON.stringify(result,null,2)}\n`);
  console.log(`Shadow labeling candidates: ${result.count}`);
  console.log(`SAFE ${result.summary.safe}; clarification ${result.summary.clarification}; handoff ${result.summary.handoff}; parser failures ${result.summary.parserFailures}`);
  console.log(`Human-label file: ${output}`);
}

