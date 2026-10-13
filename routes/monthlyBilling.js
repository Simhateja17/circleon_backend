const express = require('express');
const { getOrCreateWorkspace } = require('../lib/workspace');
const { getBilling } = require('../lib/billing');
const m = require('../lib/monthlyBilling');
const { byId } = require('../lib/pricing');
const router = express.Router();
const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (error) { res.status(error.status || 400).json({ error: error.message || 'Billing request failed.' }); } };
async function owner(req) { const w = await getOrCreateWorkspace(req.supabase, req.user); if (w.owner_id !== req.user.id) throw Object.assign(new Error('Only the workspace owner manages billing and teammates.'), { status: 403 }); return w; }
function internal(req, res, next) {
  const ids = (process.env.CIRCLEON_ADMIN_USER_IDS || '').split(',').map(v => v.trim()).filter(Boolean);
  if (!ids.includes(req.user.id)) return res.status(403).json({ error: 'Internal CircleOn access only.' });
  return next();
}
router.get('/admin', internal, wrap(async (req, res) => {
  const db = m.service();
  const [settings, customers, demos] = await Promise.all([
    m.settings(db), m.result(db.from('workspaces').select('id,name,workspace_billing(*)').order('created_at', { ascending: false }).limit(200)),
    m.result(db.from('demo_requests').select('*').order('created_at', { ascending: false }).limit(100)),
  ]);
  res.json({settings,customers:customers.map(w=>({...((Array.isArray(w.workspace_billing)?w.workspace_billing[0]:w.workspace_billing)||{}),workspace_id:w.id,workspaces:{name:w.name}})),demos});
}));
router.patch('/admin/settings', internal, wrap(async (req, res) => {
  const patch = {};
  for (const key of ['founding_offer_active','gst_registered','legal_ready','pdpa_verified','dnc_verified']) if (typeof req.body[key] === 'boolean') patch[key] = req.body[key];
  if ('demo_url' in req.body) { if (req.body.demo_url && !/^https:\/\//.test(req.body.demo_url)) throw new Error('Use an HTTPS booking URL.'); patch.demo_url = req.body.demo_url || null; }
  await m.result(m.service().from('pricing_settings').update(patch).eq('id', true)); res.json({ saved: true });
}));
router.patch('/admin/customers/:id', internal, wrap(async (req, res) => {
  const db = m.service(), patch = {};
  for (const key of ['trial_approved','voice_approved','voice_ready']) if (typeof req.body[key] === 'boolean') patch[key] = req.body[key];
  if ('fallback_number' in req.body) { if (!/^\+[1-9]\d{7,14}$/.test(req.body.fallback_number)) throw new Error('Enter a fallback number in international format.'); patch.fallback_number = req.body.fallback_number; }
  if ('company_trial_key' in req.body) { if(!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(req.body.company_trial_key)) throw new Error('Identify the approved company by its actual domain.'); patch.company_trial_key=req.body.company_trial_key; }
  const b = await m.result(db.from('workspace_billing').select('*').eq('workspace_id', req.params.id).maybeSingle());
  if(patch.trial_approved && !(patch.company_trial_key || b?.company_trial_key)) throw new Error('Save the actual company domain before approving a personal-email trial.');
  if (patch.voice_ready && !(patch.fallback_number || b?.fallback_number)) throw new Error('Set an inbound fallback number before marking voice ready.');
  if (patch.voice_ready && b?.subscription_status === 'trialing' && byId[b.plan]?.family === 'allinone') {
    await m.stripeClient().subscriptions.update(b.stripe_subscription_id, { cancel_at: '' });
    if(b.founding)await m.configureFounderSchedule(m.stripeClient(),await m.stripeClient().subscriptions.retrieve(b.stripe_subscription_id),{...b,voice_ready:true});
  }
  if(patch.voice_ready===false && b?.subscription_status==='trialing' && byId[b.plan]?.family==='allinone'){const stripe=m.stripeClient(),sub=await stripe.subscriptions.retrieve(b.stripe_subscription_id);if(sub.schedule)await stripe.subscriptionSchedules.release(typeof sub.schedule==='string'?sub.schedule:sub.schedule.id);await stripe.subscriptions.update(sub.id,{cancel_at:sub.trial_end});}
  await m.result(db.from('workspace_billing').upsert({ workspace_id: req.params.id, ...patch }, { onConflict: 'workspace_id' }));
  res.json({ saved: true });
}));
router.post('/extension-consent', wrap(async (req, res) => {
  const w = await owner(req), b = await getBilling(req.supabase, w.id);
  if (byId[b?.plan]?.family !== 'allinone' || b.subscription_status !== 'trialing' || b.trial_extended || b.voice_ready) throw new Error('This trial is not eligible for an extension.');
  if (req.body.consent !== true) throw new Error('Explicit consent is required.');
  const end = Math.floor(new Date(b.trial_start).getTime() / 1000) + 14 * 86400;
  if (end <= Date.now() / 1000) throw new Error('The extension window has ended.');
  const stripe = m.stripeClient();
  const subscription = await stripe.subscriptions.retrieve(b.stripe_subscription_id);
  if (subscription.schedule) await stripe.subscriptionSchedules.release(typeof subscription.schedule === 'string' ? subscription.schedule : subscription.schedule.id);
  await stripe.subscriptions.update(subscription.id, { trial_end: end, cancel_at: end, proration_behavior: 'none' });
  const patch = { trial_extended: true, extension_consent_at: new Date().toISOString(), trial_end: new Date(end * 1000).toISOString() };
  // Extend the discount expiry by the same seven days: still six paid months.
  if (b.founding) patch.founder_until = new Date(m.sixMonthsAfter(end) * 1000).toISOString();
  await m.result(m.service().from('workspace_billing').update(patch).eq('workspace_id', w.id));
  await m.result(m.service().from('founding_reservations').update({ expires_at: new Date(end * 1000 + 48 * 3600000).toISOString() }).eq('workspace_id', w.id).eq('state','reserved'));
  res.json({ extended: true });
}));
router.patch('/overage', wrap(async (req, res) => {
  const w = await owner(req), b = await getBilling(req.supabase, w.id), plan = byId[b?.plan];
  if (!plan || b.subscription_status !== 'active' || b.payment_failed) throw new Error('Overage is available only on an active paid monthly plan.');
  const patch = {};
  for (const key of ['lead_overage_cap_cents','voice_overage_cap_cents']) if (key in req.body) {
    const n = req.body[key]; if (!Number.isSafeInteger(n) || n < 0 || n > 10000000) throw new Error('Enter a valid monthly spending cap in cents. Zero disables overage.');
    if (n > 0 && req.body.accept_rates !== true) throw new Error('Accept S$1 per extra lead with four emails and S$0.60 per extra voice minute.');
    if (n > 0 && (key.startsWith('lead') ? !plan.leads : !plan.minutes)) throw new Error('This overage is not available on your plan.');
    patch[key] = n;
  }
  await m.result(m.service().from('workspace_billing').update(patch).eq('workspace_id', w.id)); res.json({ saved: true });
}));
router.post('/cancel', wrap(async (req, res) => {
  const w = await owner(req), b = await getBilling(req.supabase, w.id); if (!b?.stripe_subscription_id) throw new Error('No subscription to cancel.');
  const stripe = m.stripeClient(), sub = await stripe.subscriptions.retrieve(b.stripe_subscription_id);
  if (sub.schedule) await stripe.subscriptionSchedules.release(typeof sub.schedule === 'string' ? sub.schedule : sub.schedule.id);
  const updated = b.subscription_status === 'trialing' ? await stripe.subscriptions.cancel(sub.id, { invoice_now: false, prorate: false }) : await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
  await m.result(m.service().from('workspace_billing').update({ subscription_status: updated.status, cancel_at_period_end: updated.cancel_at_period_end }).eq('workspace_id', w.id));
  if (b.subscription_status === 'trialing') await m.result(m.service().from('founding_reservations').update({ state: 'released' }).eq('workspace_id', w.id).eq('state', 'reserved'));
  res.json({ canceled: true });
}));
router.get('/team', wrap(async (req, res) => {
  const w = await getOrCreateWorkspace(req.supabase, req.user);
  res.json({ members: await m.result(m.service().from('workspace_members').select('id,email,status,user_id').eq('workspace_id', w.id)), ownerId: w.owner_id });
}));
router.post('/team', wrap(async (req, res) => {
  const w = await owner(req), email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email === req.user.email.toLowerCase()) throw new Error('Enter a teammate’s email address.');
  const member = await m.result(m.service().from('workspace_members').upsert({ workspace_id: w.id, email, status: 'pending' }, { onConflict: 'workspace_id,email' }).select('id').single());
  await m.notify(m.service(), w.id, `invite:${member.id}:${Date.now()}`, 'Teammate invitation created', `Invitation for ${email}. Ask them to sign in to CircleOn and accept from /team-invite.`);
  res.status(201).json({ invited: true, acceptUrl: '/team-invite' });
}));
router.delete('/team/:id', wrap(async (req, res) => {
  const w = await owner(req); await m.result(m.service().from('workspace_members').update({ status: 'revoked', user_id: null }).eq('workspace_id',w.id).eq('id',req.params.id)); res.json({ revoked: true });
}));
router.get('/invitations', wrap(async (req, res) => {
  res.json({ invitations: await m.result(m.service().from('workspace_members').select('id,workspace_id,workspaces(name)').eq('email',req.user.email.toLowerCase()).eq('status','pending')) });
}));
router.post('/invitations/:id/accept', wrap(async (req, res) => {
  const db=m.service();
  const owned = await m.result(db.from('workspaces').select('id,plan').eq('owner_id',req.user.id).maybeSingle());
  if (owned?.plan) throw new Error('This account already owns a subscribed workspace. Use a separate account to join this team.');
  await m.result(db.from('workspace_members').update({ status:'active', user_id:req.user.id }).eq('id',req.params.id).eq('email',req.user.email.toLowerCase()).eq('status','pending').select('id').single());
  res.json({ accepted:true });
}));
router.get('/retention', wrap(async(req,res)=>{const w=await owner(req);res.json({campaigns:await m.result(m.service().from('campaigns').select('id,name').eq('workspace_id',w.id).eq('status','active'))});}));
router.post('/change-plan', wrap(async (req, res) => {
  const w = await owner(req), db=m.service(), b = await getBilling(req.supabase,w.id), next=byId[req.body.plan], old=byId[b?.plan];
  if (!old || !next || b.subscription_status !== 'active' || b.payment_failed) throw new Error('Changes require an active paid monthly subscription. Legacy customers require an agreed migration.');
  if (old.id===next.id) throw new Error('You already have this plan.');
  // Cross-family migrations change setup/voice readiness and need operator review.
  if (old.family!==next.family) throw new Error('Contact CircleOn to change plan families.');
  const downgrade = next.list<old.list;
  if (downgrade) {
    const keepMembers=req.body.keep_member_ids, keepCampaigns=req.body.keep_campaign_ids;
    if (!Array.isArray(keepMembers) || !Array.isArray(keepCampaigns)) throw new Error('Select the teammates and active campaigns to retain.');
    if (keepMembers.length>next.seats-1 || (next.campaigns!==null && keepCampaigns.length>next.campaigns)) throw new Error('Your retention selection exceeds the new plan limits.');
    await m.result(db.from('billing_plan_changes').upsert({workspace_id:w.id,plan:next.id,keep_member_ids:keepMembers,keep_campaign_ids:keepCampaigns}, {onConflict:'workspace_id'}));
  }
  const stripe=m.stripeClient(); let sub=await stripe.subscriptions.retrieve(b.stripe_subscription_id);
  if (downgrade) {
    if (b.founding && new Date(b.founder_until)>new Date()) await m.configureFounderSchedule(stripe,sub,b,old,next);
    else {
      const schedule=sub.schedule ? await stripe.subscriptionSchedules.retrieve(typeof sub.schedule==='string'?sub.schedule:sub.schedule.id) : await stripe.subscriptionSchedules.create({from_subscription:sub.id});
      const item=sub.items.data.find(i=>i.price.recurring?.usage_type!=='metered');
      const price=await m.findPrice(stripe,next.lookup+'_list',next.list*100);
      const meters=sub.items.data.filter(i=>i.price.recurring?.usage_type==='metered').map(i=>({price:i.price.id}));
      await stripe.subscriptionSchedules.update(schedule.id,{end_behavior:'release',phases:[{start_date:schedule.current_phase.start_date,end_date:item.current_period_end,items:[{price:item.price.id,quantity:1},...meters]},{start_date:item.current_period_end,duration:{interval:'month',interval_count:1},items:[{price:price.id,quantity:1},...meters],metadata:{...sub.metadata,plan:next.id}}]});
    }
    await m.result(db.from('workspace_billing').update({pending_plan:next.id}).eq('workspace_id',w.id));
  } else {
    const discounted=b.founding && new Date(b.founder_until)>new Date();
    const price=await m.findPrice(stripe,next.lookup+(discounted?'_founding':'_list'),(discounted?next.founding:next.list)*100);
    if (sub.schedule) await stripe.subscriptionSchedules.release(typeof sub.schedule==='string'?sub.schedule:sub.schedule.id);
    try {
      const item=sub.items.data.find(i=>i.price.recurring?.usage_type!=='metered');
      sub=await stripe.subscriptions.update(sub.id,{items:[{id:item.id,price:price.id}],metadata:{...sub.metadata,plan:next.id},proration_behavior:'always_invoice',payment_behavior:'error_if_incomplete'});
    } catch(error) { if(discounted) await m.configureFounderSchedule(stripe,await stripe.subscriptions.retrieve(sub.id),b); throw error; }
    await m.result(db.from('workspace_billing').update({plan:next.id}).eq('workspace_id',w.id));
    await m.result(db.from('workspaces').update({plan:next.id}).eq('id',w.id));
    if(discounted) await m.configureFounderSchedule(stripe,sub,{...b,plan:next.id});
  }
  res.json({changed:true,atRenewal:downgrade});
}));
module.exports=router;
