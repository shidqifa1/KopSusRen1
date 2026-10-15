import path from 'node:path';
import { evaluateDataset,loadDataset,writeJsonReport } from './lib.mjs';

const args=new Map(process.argv.slice(2).map(value=>value.startsWith('--')?value.slice(2).split('='):[value,true]));
const provider=args.get('provider')||'deterministic';
if (!['deterministic','groq'].includes(provider)) throw new Error('Provider harus deterministic atau groq');
if (provider==='groq'&&!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY diperlukan untuk --provider=groq');
const datasetPath=path.resolve(args.get('dataset')||'evals/chatbot-cases.json');
const outputPath=path.resolve(args.get('output')||'evals/latest-report.json');
const numeric=(name,fallback)=>{
  const value=args.has(name)?Number(args.get(name)):fallback;
  if (!Number.isFinite(value)||value<0) throw new Error(`--${name} harus angka >= 0`);
  return value;
};
const pacingMs=numeric('pacing-ms',provider==='groq'?750:0);
const retryPolicy=provider==='groq'?{
  maxPrimaryAttempts:numeric('max-primary-attempts',3),
  maxFallbackAttempts:numeric('max-fallback-attempts',2),
  baseBackoffMs:numeric('base-backoff-ms',1000),
  maxBackoffMs:numeric('max-backoff-ms',10000),
  jitterRatio:numeric('jitter-ratio',.2),
  fallbackModel:args.get('fallback-model')||'openai/gpt-oss-20b',
}:null;
const report=await evaluateDataset(await loadDataset(datasetPath),{provider,pacingMs,retryPolicy});
await writeJsonReport(outputPath,report);
const pct=value=>`${(value*100).toFixed(2)}%`;
const printMetrics=(metrics,prefix='')=>{
  for (const [name,value] of Object.entries(metrics)) {
    if (value&&typeof value==='object') printMetrics(value,`${prefix}${name}.`);
    else console.log(`${prefix}${name}: ${name.endsWith('Ms')?Number(value).toFixed(2):pct(Number(value))}`);
  }
};
console.log(`Chatbot evaluation · ${report.provider}/${report.model}`);
console.log(`Dataset v${report.datasetVersion}: ${report.caseCount} cases / ${report.turnCount} turns`);
console.log(`Parser success: ${report.denominators.parserSucceededTurns}/${report.denominators.allTurns}; network: ${report.denominators.successfulNetworkTurns}/${report.denominators.networkParserAttempts}`);
console.log(`Attempts: ${report.attemptSummary.totalModelAttempts}; primary: ${report.attemptSummary.primarySuccessCount}; retry: ${report.attemptSummary.retrySuccessCount}; fallback: ${report.attemptSummary.fallbackSuccessCount}; backoff: ${report.attemptSummary.totalBackoffMs} ms`);
printMetrics(report.metrics);
console.log('\nAcceptance:');
console.log(`Complete-order accuracy >=95%: ${report.metrics.completeOrderAccuracy>=.95?'PASS':'FAIL'}`);
console.log(`Critical silent error <1%: ${report.metrics.criticalSilentErrorRate<.01?'PASS':'FAIL'}`);
console.log(`Ambiguous detection >=95%: ${report.metrics.ambiguityDetection>=.95?'PASS':'FAIL'}`);
console.log(`False-order safe acceptance ~0%: ${report.metrics.falseOrderRate===0?'PASS':'FAIL'}`);
console.log(`Critical failures: ${report.criticalFailures.length}; recoverable: ${report.recoverableFailures.length}`);
console.log(`JSON report: ${outputPath}`);
