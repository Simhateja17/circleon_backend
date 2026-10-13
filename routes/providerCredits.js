const express = require('express');
const requireAuth = require('../middleware/auth');
const {createServiceClient} = require('../lib/supabase');
const {fetchApolloCredits,manualSnapshot,isInternalAdmin} = require('../lib/providerCredits');
const router = express.Router();
router.use(requireAuth);
router.use((req,res,next)=>isInternalAdmin(req.user)?next():res.status(403).json({error:'Internal CircleOn access only.'}));
const wrap = fn => async(req,res)=>{try{await fn(req,res);}catch(error){res.status(400).json({error:error.message||'Credit monitoring request failed.'});}};
function service(){const db=createServiceClient();if(!db)throw new Error('Service database access is not configured.');return db;}
async function result(query){const {data,error}=await query;if(error)throw error;return data;}
router.get('/',wrap(async(req,res)=>{
  const db=service();
  const [snapshots,clients]=await Promise.all([
    result(db.from('provider_credit_snapshots').select('id,provider,source,balances,cycle,verified_at,source_note,created_at').order('verified_at',{ascending:false}).limit(20)),
    result(db.rpc('provider_credit_client_usage')),
  ]);
  res.json({snapshots,clients,as_of:new Date().toISOString(),scope:'Apollo team balance across all seats. Credit types may share one pool; do not sum them.'});
}));
router.post('/refresh',wrap(async(req,res)=>{
  const snapshot=await fetchApolloCredits();
  await result(service().from('provider_credit_snapshots').insert({...snapshot,provider:'apollo',source:'api',verified_at:new Date().toISOString(),source_note:'Apollo team credit_usage_stats API',recorded_by:req.user.id}));
  res.json({saved:true});
}));
router.post('/manual',wrap(async(req,res)=>{
  const snapshot=manualSnapshot(req.body);
  await result(service().from('provider_credit_snapshots').insert({...snapshot,provider:'apollo',source:'manual',recorded_by:req.user.id}));
  res.json({saved:true});
}));
module.exports=router;
