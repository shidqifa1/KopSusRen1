function versionsEqual(left,right) {
  return (left||null)===(right||null);
}

export function decideParsedResultApplicability({snapshotVersion,currentVersion,messageCreatedAt,lastAppliedAt}) {
  const messageTime=new Date(messageCreatedAt||0).getTime();
  const appliedTime=new Date(lastAppliedAt||0).getTime();
  if (Number.isFinite(messageTime)&&Number.isFinite(appliedTime)&&appliedTime>0&&messageTime<=appliedTime) return 'STALE';
  if (versionsEqual(snapshotVersion,currentVersion)) return 'APPLY';
  return 'RETRY';
}

export async function runInboundPipeline({payload,register,prepare,apply,maxAttempts=3,onExhausted=null}) {
  const registration=await register(payload);
  if (registration.duplicate) return {duplicate:true};
  if (registration.finalResult) return registration.finalResult;
  let prepared=null;
  for (let attempt=0;attempt<maxAttempts;attempt+=1) {
    prepared=await prepare(payload,registration);
    const outcome=await apply(payload,registration,prepared);
    if (outcome.status==='RETRY') continue;
    return outcome.result;
  }
  if (onExhausted) return onExhausted(payload,registration,prepared);
  return {id:registration.messageId,replyText:'Pesan lain masuk bersamaan. Coba kirim ulang pesan terakhir ya.'};
}
