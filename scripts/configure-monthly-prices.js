// Run explicitly against Stripe test mode first. Idempotent by lookup key.
require('dotenv').config();
const { plans }=require('../lib/pricing');
const { stripeClient }=require('../lib/monthlyBilling');
async function main(){
 const stripe=stripeClient();
 async function ensure(key,amount,product,monthly=false){const old=await stripe.prices.list({lookup_keys:[key],active:true,limit:1});if(old.data.length){if(old.data[0].unit_amount!==amount||old.data[0].currency!=='sgd')throw new Error('Existing price differs: '+key);return;}await stripe.prices.create({product,lookup_key:key,currency:'sgd',unit_amount:amount,tax_behavior:'exclusive',...(monthly?{recurring:{interval:'month'}}:{})},{idempotencyKey:'circleon-price:'+key});console.log('Created',key);}
 for(const p of plans){const product=await stripe.products.create({name:'CircleOn '+p.name,metadata:{plan:p.id,pricing_version:'monthly_v3'}},{idempotencyKey:'circleon-product:'+p.id});await ensure(p.lookup+'_list',p.list*100,product.id,true);await ensure(p.lookup+'_founding',p.founding*100,product.id,true);}
 for(const [family,cost,key] of [['Follow Up',200,'fu'],['Voice Agent',500,'va'],['All-in-one',650,'aio']]){const product=await stripe.products.create({name:'CircleOn '+family+' setup'},{idempotencyKey:'circleon-setup:'+key});await ensure('setup_'+key,cost*100,product.id);}
 for(const [key,cost,label] of [['overage_leads',100,'Extra lead including four emails'],['overage_voice_minutes',60,'Extra AI minute']]){const product=await stripe.products.create({name:'CircleOn '+label},{idempotencyKey:'circleon-overage:'+key});await ensure(key,cost,product.id);}
 console.log('Monthly catalogue configured. Legacy prices were not changed.');
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
