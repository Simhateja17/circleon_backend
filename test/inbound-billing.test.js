const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('crypto');
const {verifyTwilio,inboundResponse}=require('../lib/inboundBilling');
test('Twilio signature binds account token, complete public URL and form parameters',()=>{
 const url='https://api.circleon.test/api/billing/inbound/workspace';const body={CallSid:'CA123',AccountSid:'AC123',From:'+6512345678',To:'+6587654321'};
 const input=url+Object.keys(body).sort().map(k=>k+body[k]).join('');
 const signature=crypto.createHmac('sha1','secret').update(input).digest('base64');
 const req={body,headers:{'x-twilio-signature':signature}};
 assert.equal(verifyTwilio(req,'secret',url),true);
 assert.equal(verifyTwilio(req,'other',url),false);
 assert.equal(verifyTwilio(req,'secret',url+'?other=true'),false);
 assert.equal(verifyTwilio({...req,body:{...body,To:'+6500000000'}},'secret',url),false);
 assert.equal(verifyTwilio(req,null,url),false);
});
test('a pending retry or failed registration falls back rather than dialing sip:null',()=>{
 let fellBack=0;const fallback=()=>{fellBack++;return 'fallback';};
 const res={type(){return this;},send(xml){return xml;}};
 assert.equal(inboundResponse(res,{status:'queued',retell_call_id:null},fallback),'fallback');
 assert.equal(inboundResponse(res,{status:'failed',retell_call_id:'registered'},fallback),'fallback');
 assert.equal(inboundResponse(res,{status:'completed',retell_call_id:'registered'},fallback),'fallback');
 assert.equal(fellBack,3);
 assert.match(inboundResponse(res,{status:'queued',retell_call_id:'registered'},fallback),/sip:registered@sip.retellai.com/);
});
test('registration failure releases its queued slot and retries do not register again',async()=>{
 const m=require('../lib/monthlyBilling'),p=require('../lib/voiceAgentProvisioning');const saved={service:m.service,access:m.voiceAccess,load:p.loadWorkspaceAgent,fetch:global.fetch,tokens:process.env.BILLING_TWILIO_ACCOUNT_TOKENS,url:process.env.API_PUBLIC_URL};let row=null,count=0;
 const db={from(table){let op='select',patch;const q={select(){return q;},eq(){return q;},in(){return q;},maybeSingle(){return q;},single(){return q;},insert(v){op='insert';patch=v;return q;},update(v){op='update';patch=v;return q;},then(resolve,reject){let data=null;if(table==='workspace_billing')data={fallback_number:'+6512345678'};if(table==='workspace_telephony')data={from_number:'+6587654321'};if(table==='calls'){if(op==='insert')row={id:'call1',...patch};if(op==='update')Object.assign(row,patch);data=row;}return Promise.resolve({data,error:null,count:0}).then(resolve,reject);}};return q;}};
 m.service=()=>db;m.voiceAccess=async()=>({ok:true,concurrency:1});p.loadWorkspaceAgent=async()=>({id:'agent1',retell_agent_id:'retell1',shared_scope:true,status:'ready',inbound_approved_at:'today',inbound_prompt:'Answer support questions',inbound_opening_line:'How can I help?'});global.fetch=async()=>{count++;return {ok:false,json:async()=>({})};};process.env.BILLING_TWILIO_ACCOUNT_TOKENS='{"AC123":"secret"}';process.env.API_PUBLIC_URL='https://api.circleon.test';
 delete require.cache[require.resolve('../lib/inboundBilling')];const {handleInbound}=require('../lib/inboundBilling');const body={CallSid:'CA123',AccountSid:'AC123',From:'+6500000000',To:'+6587654321'},url='/api/billing/inbound/w1';const input=process.env.API_PUBLIC_URL+url+Object.keys(body).sort().map(k=>k+body[k]).join('');const req={params:{id:'w1'},originalUrl:url,body,headers:{'x-twilio-signature':crypto.createHmac('sha1','secret').update(input).digest('base64')}};const res={type(){return this;},send(xml){return xml;},sendStatus(code){throw new Error(String(code));}};
 try{assert.match(await handleInbound(req,res),/<Dial>\+6512345678/);assert.equal(row.status,'failed');assert.equal(row.twilio_call_sid,'CA123');assert.match(await handleInbound(req,res),/<Dial>\+6512345678/);assert.equal(count,1);}finally{m.service=saved.service;m.voiceAccess=saved.access;p.loadWorkspaceAgent=saved.load;global.fetch=saved.fetch;for(const [k,v]of [['BILLING_TWILIO_ACCOUNT_TOKENS',saved.tokens],['API_PUBLIC_URL',saved.url]]){if(v===undefined)delete process.env[k];else process.env[k]=v;}delete require.cache[require.resolve('../lib/inboundBilling')];}
});
