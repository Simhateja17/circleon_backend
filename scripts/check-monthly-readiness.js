// Read-only provider checks. Never creates customers, subscriptions or messages.
require('dotenv').config();
const m=require('../lib/monthlyBilling');
const c=require('../lib/billingConfiguration');
async function check({env=process.env,db=m.service(),stripe}={}){
 const missing=c.configurationIssues(env);
 const report={missing,checks:[],ready:false};
 const config=await m.settings(db);report.checks.push({name:'legal approval',ok:config.legal_ready});
 if(!c.validSecret(env.STRIPE_SECRET_KEY,'sk_'))return report;
 stripe=stripe||m.stripeClient();
 for(const expected of c.expectedPrices()){
  try{const response=await stripe.prices.list({lookup_keys:[expected.lookup],active:true,limit:1});c.assertPrice(response.data[0],expected);report.checks.push({name:expected.lookup,ok:true});}
  catch(error){report.checks.push({name:expected.lookup,ok:false,error:error.message});}
 }
 if(env.STRIPE_MONTHLY_PORTAL_CONFIGURATION_ID){try{c.assertMonthlyPortal(await stripe.billingPortal.configurations.retrieve(env.STRIPE_MONTHLY_PORTAL_CONFIGURATION_ID));report.checks.push({name:'restricted monthly portal',ok:true});}catch(error){report.checks.push({name:'restricted monthly portal',ok:false,error:error.message});}}
 report.ready=!missing.length&&report.checks.every(x=>x.ok);return report;
}
if(require.main===module)check().then(report=>{console.log(JSON.stringify(report,null,2));if(!report.ready)process.exitCode=1;}).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={check};
