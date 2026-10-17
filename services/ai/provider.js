// Shared by owner extraction, customer parsing, and conversational replies.
export function aiConfig() {
  const provider=process.env.AI_PROVIDER||'groq';
  if(!['groq','gemini'].includes(provider))throw Error('AI_PROVIDER must be groq or gemini');
  return provider==='gemini'
    ?{provider,model:process.env.GEMINI_MODEL||'gemini-3.5-flash-lite',key:process.env.GEMINI_API_KEY,baseUrl:'https://generativelanguage.googleapis.com/v1beta/openai'}
    :{provider,model:process.env.GROQ_MODEL||'openai/gpt-oss-120b',key:process.env.GROQ_API_KEY,baseUrl:'https://api.groq.com/openai/v1'};
}

export async function requestChatCompletion(body,{signal=AbortSignal.timeout(7000)}={}) {
  const config=aiConfig();
  if(!config.key)throw Error(`${config.provider==='gemini'?'GEMINI':'GROQ'}_API_KEY is not configured`);
  const request={...body};
  if(config.provider==='gemini'){
    request.model=config.model;
    // Keep reasoning at the lowest supported setting for extraction.
    request.reasoning_effort=config.model.startsWith('gemini-2.5-')?'none':'minimal';
  }
  return fetch(`${config.baseUrl}/chat/completions`,{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.key}`},
    body:JSON.stringify(request),signal,
  });
}

export async function chatCompletion(body,options) {
  const response=await requestChatCompletion(body,options);
  if(!response.ok){
    const error=new Error(`AI provider request failed (${response.status})`);
    error.status=response.status;error.headers=response.headers;
    throw error;
  }
  return response.json();
}
