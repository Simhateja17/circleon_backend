require('dotenv').config();
const nodemailer=require('nodemailer');
const m=require('../lib/monthlyBilling');
const {byId}=require('../lib/pricing');
async function count(db,table,wid,column,since){const {count,error}=await db.from(table).select('id',{count:'exact',head:true}).eq('workspace_id',wid).gte(column,since);if(error)throw error;return count||0;}
async function processBilling(db=m.service(),stripe=m.stripeClient(),now=new Date()){
 const customers=await m.result(db.from('workspace_billing').select('*,workspaces(owner_id,name)').in('plan',Object.keys(byId)));
 for(const b of customers){
  try{
   const plan=byId[b.plan],trial=b.subscription_status==='trialing';
   if(b.subscription_status==='canceled'&&b.stripe_subscription_id)await m.billFinalUsage(db,stripe,b);
   if(trial){
    const elapsed=(now-new Date(b.trial_start))/86400000;
    for(const [days,key,subject,body] of [[0,'welcome','Welcome to your CircleOn trial','Connect your own verified mailbox. Your total trial allowance is 50 leads and 200 emails. Voice is not included.'],[5,'day5','Your CircleOn trial ends in two days','Review your plan and cancel before conversion to avoid charges.'],[6,'day6','Your CircleOn trial ends tomorrow',`${plan.name}: S$${b.founding?plan.founding:plan.list}/month excl. GST. ${b.founding?'Setup waived.':`Setup: S$${plan.setup} excl. GST.`} ${process.env.FRONTEND_URL}/dashboard?page=billing`]]){
     if((days===0?elapsed>=0:(now>=new Date(new Date(b.trial_end).getTime()-(days===5?2:1)*86400000)&&now<new Date(b.trial_end))))await m.notify(db,b.workspace_id,`trial:${b.stripe_subscription_id}:${key}:${days===0?'welcome':b.trial_end}`,subject,body);
    }
   }
   const usage=await m.usage(db,b);
   if(usage)for(const kind of ['leads','emails','minutes']){const max=usage.limits[kind];if(!max)continue;for(const threshold of [80,100])if(usage.used[kind]>=max*threshold/100)await m.notify(db,b.workspace_id,`usage:${usage.periodStart}:${kind}:${threshold}`,`${threshold}% of ${kind} allowance used`,`You have used ${usage.used[kind]} of ${max} ${kind}. Review your limits and optional paid overage in Billing.`);}
   if(plan.tier!=='starter'&&b.subscription_status==='active'){
    const week=Math.floor(now.getTime()/(7*86400000));const since=new Date(now.getTime()-7*86400000).toISOString();
    const [leads,emails,messages,meetings,calls]=await Promise.all([count(db,'leads',b.workspace_id,'created_at',since),count(db,'messages',b.workspace_id,'sent_at',since),m.result(db.from('messages').select('id').eq('workspace_id',b.workspace_id).eq('direction','inbound').gte('created_at',since)),count(db,'meetings',b.workspace_id,'created_at',since),count(db,'calls',b.workspace_id,'created_at',since)]);
    await m.notify(db,b.workspace_id,`weekly:${week}`,'Your weekly CircleOn report',`${plan.name}\nLeads added: ${leads}\nEmails sent: ${emails}\nReplies: ${messages.length}\nMeetings: ${meetings}\nCalls: ${calls}\nReview your dashboard for details.${plan.tier==='pro'?' Your plan includes a monthly review call; contact support to schedule.':''}`);
   }
   const reservation=await m.result(db.from('founding_reservations').select('*').eq('workspace_id',b.workspace_id).maybeSingle());
   if(reservation?.state==='reserved'&&new Date(reservation.expires_at)<=now&&!b.stripe_subscription_id){
    const session=b.stripe_checkout_session_id?await stripe.checkout.sessions.retrieve(b.stripe_checkout_session_id):null;
    if(session?.status==='complete'&&session.subscription)await require('../routes/billing').syncSubscription(db,await stripe.subscriptions.retrieve(session.subscription));
    else if(!session||session.status==='expired')await m.result(db.from('founding_reservations').update({state:'released'}).eq('workspace_id',b.workspace_id).eq('state','reserved'));
   }
   if(reservation?.state==='reserved'&&new Date(reservation.expires_at)<=now&&b.stripe_subscription_id){
    const sub=await stripe.subscriptions.retrieve(b.stripe_subscription_id);
    const invoice=typeof sub.latest_invoice==='string'?await stripe.invoices.retrieve(sub.latest_invoice):sub.latest_invoice;
    if(sub.status==='active'&&invoice?.status==='paid'&&invoice.amount_paid>0)await m.result(db.from('founding_reservations').update({state:'confirmed',expires_at:null}).eq('workspace_id',b.workspace_id));
    else if(sub.status==='canceled')await m.result(db.from('founding_reservations').update({state:'released'}).eq('workspace_id',b.workspace_id).eq('state','reserved'));
    else if(['past_due','unpaid','incomplete'].includes(sub.status)){
     await stripe.subscriptions.cancel(sub.id,{invoice_now:false,prorate:false});
     if(invoice&&invoice.status==='open')await stripe.invoices.voidInvoice(invoice.id);
     await m.result(db.from('founding_reservations').update({state:'released'}).eq('workspace_id',b.workspace_id).eq('state','reserved'));
    }
   }
  }catch(error){console.error('[billing-worker]',b.workspace_id,error.message);}
 }
 // A durable outbox means provider failures don't discard reminders/reports.
 if(process.env.BILLING_SMTP_URL&&process.env.BILLING_FROM_EMAIL){
  const transport=nodemailer.createTransport(process.env.BILLING_SMTP_URL);
  const pending=await m.result(db.from('billing_notifications').select('*').is('sent_at',null).order('created_at').limit(100));
  for(const n of pending){try{const w=await m.result(db.from('workspaces').select('owner_id').eq('id',n.workspace_id).single());const {data,error}=await db.auth.admin.getUserById(w.owner_id);if(error)throw error;await transport.sendMail({from:process.env.BILLING_FROM_EMAIL,to:data.user.email,subject:n.subject,text:n.body,messageId:`<${Buffer.from(n.workspace_id+':'+n.notification_key).toString('base64url')}@circleon.ai>`});await m.result(db.from('billing_notifications').update({sent_at:new Date().toISOString()}).eq('workspace_id',n.workspace_id).eq('notification_key',n.notification_key));}catch(error){console.error('[billing-mail]',error.message);}}
 }
}
if(require.main===module){let running=false;const tick=async()=>{if(running)return;running=true;try{await processBilling();}catch(e){console.error('[billing-worker]',e.message);}finally{running=false;}};tick();setInterval(tick,60000);}
module.exports={processBilling};
