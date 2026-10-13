// Explicit provider mutation. Run in test mode before production activation.
require('dotenv').config();
const {stripeClient}=require('../lib/monthlyBilling');
const {monthlyPortalParameters,assertMonthlyPortal,validSecret}=require('../lib/billingConfiguration');
async function configure(stripe, env=process.env) {
  const params=monthlyPortalParameters(env.FRONTEND_URL);
  if(env.STRIPE_MONTHLY_PORTAL_CONFIGURATION_ID){const existing=await stripe.billingPortal.configurations.retrieve(env.STRIPE_MONTHLY_PORTAL_CONFIGURATION_ID);assertMonthlyPortal(existing);return existing.id;}
  const existing=await stripe.billingPortal.configurations.list({active:true,limit:100});
  const found=existing.data.find(c=>c.metadata?.circleon_configuration==='monthly_v3');
  if(found){assertMonthlyPortal(found);return found.id;}
  const configuration=await stripe.billingPortal.configurations.create(params,{idempotencyKey:'circleon-monthly-portal-v3'});
  assertMonthlyPortal(configuration);return configuration.id;
}
if(require.main===module){if(!validSecret(process.env.STRIPE_SECRET_KEY,'sk_'))throw new Error('Configure a real Stripe secret key before running this script.');configure(stripeClient()).then(id=>console.log('Set STRIPE_MONTHLY_PORTAL_CONFIGURATION_ID='+id)).catch(e=>{console.error(e.message);process.exitCode=1;});}
module.exports={configure};
