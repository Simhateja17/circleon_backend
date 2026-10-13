const {byId}=require('./pricing');
// Allocate actual answered seconds, without per-call/minute rounding. A call's
// end timestamp anchors provider duration; the subscription history owns bounds.
function allocateVoiceSeconds(call,periods){
 const seconds=Number(call.duration_seconds);if(call.status!=='completed'||!Number.isFinite(seconds)||seconds<=0)return [];
 const end=Date.parse(call.ended_at),start=Date.parse(call.started_at);
 const to=Number.isFinite(end)?end:(Number.isFinite(start)?start+seconds*1000:NaN);
 if(!Number.isFinite(to))throw new Error('Completed voice usage requires a provider start or end timestamp.');
 const from=to-seconds*1000;
 const sorted=periods.filter(p=>byId[p.plan_id]?.minutes>0&&!p.is_trial).sort((a,b)=>Date.parse(a.period_start)-Date.parse(b.period_start));
 const result=[];let allocated=0;
 for(const p of sorted){const lo=Math.max(from,Date.parse(p.period_start)),hi=Math.min(to,Date.parse(p.period_end));if(hi>lo){const amount=(hi-lo)/1000;allocated+=amount;result.push({period_start:p.period_start,plan_id:p.plan_id,seconds:amount});}}
 if(Math.abs(allocated-seconds)>0.001)throw new Error('Subscription period history does not cover the answered call. Usage requires operator reconciliation.');
 return result;
}
async function chargeMonthlyVoice(db,call){
 const {data:periods,error}=await db.from('billing_period_history').select('*').eq('workspace_id',call.workspace_id);if(error)throw error;
 const allocations=allocateVoiceSeconds(call,periods||[]);if(!allocations.length)return;
 const {error:chargeError}=await db.rpc('record_voice_period_usage',{p_workspace_id:call.workspace_id,p_call_id:call.id,p_allocations:allocations});if(chargeError)throw chargeError;
}
module.exports={allocateVoiceSeconds,chargeMonthlyVoice};
