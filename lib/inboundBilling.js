const crypto=require('crypto');
const m=require('./monthlyBilling');
const {loadWorkspaceAgent}=require('./voiceAgentProvisioning');
const {composeOpeningLine}=require('./voiceScript');
const {retellLanguage}=require('./retellVoice');
const {decrypt}=require('./crypto');
function inboundContext(agent){
 if(!agent?.shared_scope||agent.status!=='ready'||!agent.inbound_approved_at||!agent.inbound_prompt||!agent.inbound_opening_line)return null;
 return {circleon_call_prompt:`You are an AI assistant answering an inbound call. Disclose that you are AI. Respect requests to end the call or not be contacted. Do not mislead, invent facts, or apply any outbound campaign script.\n${agent.inbound_prompt}`,circleon_opening_line:composeOpeningLine({openingLine:agent.inbound_opening_line,agentName:'CircleOn AI',companyName:'the company',language:agent.inbound_language,recordingEnabled:true})};
}
const escape=value=>String(value||'').replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
function verifyTwilio(req,token,url){if(!token)return false;const input=url+Object.keys(req.body||{}).sort().map(k=>k+req.body[k]).join('');const expected=crypto.createHmac('sha1',token).update(input).digest('base64');const got=String(req.headers['x-twilio-signature']||'');return got.length===expected.length&&crypto.timingSafeEqual(Buffer.from(got),Buffer.from(expected));}
// The workspace's own Twilio Auth Token signs its webhooks. Workspaces that
// predate BYOK fall back to the deployment-level token map.
async function signingToken(db,workspaceId,accountSid){
 const telephony=await m.result(db.from('workspace_telephony').select('twilio_account_sid,twilio_auth_token_encrypted,twilio_connected_at').eq('workspace_id',workspaceId).maybeSingle());
 if(telephony?.twilio_connected_at&&telephony.twilio_auth_token_encrypted)return telephony.twilio_account_sid===accountSid?decrypt(telephony.twilio_auth_token_encrypted):null;
 const config=JSON.parse(process.env.BILLING_TWILIO_ACCOUNT_TOKENS||'{}');
 return config[accountSid]||null;
}
async function handleInbound(req,res){
 const publicUrl=process.env.API_PUBLIC_URL;
 if(!publicUrl)return res.sendStatus(503);
 const db=m.service();
 let token;try{token=await signingToken(db,req.params.id,req.body?.AccountSid);}catch{return res.sendStatus(503);}
 if(!verifyTwilio(req,token,publicUrl.replace(/\/$/,'')+req.originalUrl))return res.sendStatus(403);
 let billing;try{billing=await m.result(db.from('workspace_billing').select('*').eq('workspace_id',req.params.id).single());}catch{return res.sendStatus(503);}
 let registeredCall;
 const fallback=()=>res.type('text/xml').send(`<?xml version="1.0"?><Response>${billing.fallback_number?`<Dial>${escape(billing.fallback_number)}</Dial>`:'<Say>We cannot take your call right now. Please call back later.</Say><Hangup/>'}</Response>`);
 try{
  const telephony=await m.result(db.from('workspace_telephony').select('*').eq('workspace_id',req.params.id).single());
  if(![telephony.from_number,telephony.retell_phone_number].includes(req.body.To))return res.sendStatus(403);
  if(!req.body.CallSid)return res.sendStatus(400);
 let call=await m.result(db.from('calls').select('*').eq('workspace_id',req.params.id).eq('twilio_call_sid',req.body.CallSid).maybeSingle());
 if(call)return inboundResponse(res,call,fallback);
 const access=await m.voiceAccess(db,req.params.id);if(!access?.ok)return fallback();
  const {count,error}=await db.from('calls').select('id',{count:'exact',head:true}).eq('workspace_id',req.params.id).in('status',['queued','calling','ringing','in_progress']);if(error)throw error;if(count>=access.concurrency)return fallback();
  const agent=await loadWorkspaceAgent(db,req.params.id);const context=inboundContext(agent);if(!context)return fallback();
  if(!call){
   call=await m.result(db.from('calls').insert({workspace_id:req.params.id,voice_agent_id:agent.id,from_number:req.body.From,to_number:req.body.To,status:'queued',twilio_call_sid:req.body.CallSid,raw_payload:{twilio_call_sid:req.body.CallSid}}).select('*').single());
   registeredCall=call;
   const response=await fetch((process.env.RETELL_API_BASE||'https://api.retellai.com')+'/v2/register-phone-call',{method:'POST',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+process.env.RETELL_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({agent_id:agent.retell_agent_id,from_number:req.body.From,to_number:req.body.To,direction:'inbound',retell_llm_dynamic_variables:context,agent_override:{agent:{language:retellLanguage(agent.inbound_language)}},metadata:{workspace_id:req.params.id,call_id:call.id}})});
   const payload=await response.json();if(!response.ok)throw new Error('Unable to register inbound call.');
   if(!payload.call_id)throw new Error('Retell did not return a call identifier.');
   call.retell_call_id=payload.call_id;await m.result(db.from('calls').update({retell_call_id:payload.call_id}).eq('id',call.id));
  }
  return inboundResponse(res,call,fallback);
 }catch(error){
  if(error.code==='23505'){
   try{const existing=await m.result(db.from('calls').select('*').eq('workspace_id',req.params.id).eq('twilio_call_sid',req.body.CallSid).maybeSingle());if(existing)return inboundResponse(res,existing,fallback);}catch{}
  }
  // An ambiguous external failure is never retried automatically: the provider
  // may have registered it even when its response was lost. Free the local slot.
  if(registeredCall)await db.from('calls').update({status:'failed',disconnection_reason:'inbound_registration_failed'}).eq('id',registeredCall.id).eq('status','queued');
  console.error('[billing-inbound]',error.message);return fallback();}
}
function inboundResponse(res,call,fallback){
 if(!call.retell_call_id||['failed','completed','no_answer','busy','canceled'].includes(call.status))return fallback();
 return res.type('text/xml').send(`<?xml version="1.0"?><Response><Dial><Sip>sip:${escape(call.retell_call_id)}@sip.retellai.com</Sip></Dial></Response>`);
}
module.exports={verifyTwilio,handleInbound,inboundContext,inboundResponse};
