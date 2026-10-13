const { plans } = require('./pricing');
function validSecret(value, prefix) {
  return typeof value === 'string' && value.startsWith(prefix) && value.length > prefix.length + 8 && !/placeholder|your_|xxxx|replace|example/i.test(value);
}
function configurationIssues(env = process.env) {
  const missing = [];
  if (!validSecret(env.STRIPE_SECRET_KEY, 'sk_')) missing.push('STRIPE_SECRET_KEY');
  if (!validSecret(env.STRIPE_WEBHOOK_SECRET, 'whsec_')) missing.push('STRIPE_WEBHOOK_SECRET');
  for (const key of ['FRONTEND_URL','BILLING_SMTP_URL','BILLING_FROM_EMAIL','CIRCLEON_ADMIN_USER_IDS','STRIPE_MONTHLY_PORTAL_CONFIGURATION_ID']) if (!env[key]?.trim()) missing.push(key);
  return missing;
}
function monthlyPortalParameters(frontendUrl) {
  const origin = new URL(frontendUrl);
  if (!['https:', 'http:'].includes(origin.protocol)) throw new Error('FRONTEND_URL must be an HTTP(S) URL.');
  const base = origin.origin;
  return {
    business_profile: { headline: 'Manage your CircleOn payment details', privacy_policy_url: base + '/privacy', terms_of_service_url: base + '/terms' },
    default_return_url: base + '/dashboard?page=billing',
    features: { invoice_history: { enabled: true }, payment_method_update: { enabled: true }, customer_update: { enabled: false }, subscription_cancel: { enabled: false }, subscription_update: { enabled: false } },
    metadata: { circleon_configuration: 'monthly_v3' },
  };
}
function assertMonthlyPortal(configuration) {
  const f = configuration?.features;
  if (!configuration?.active || !f?.invoice_history?.enabled || !f?.payment_method_update?.enabled || f?.subscription_cancel?.enabled || f?.subscription_update?.enabled) throw new Error('Monthly portal must allow payment updates/invoices only; use CircleOn for cancellations and plan changes.');
}
function expectedPrices() {
  return [...plans.flatMap(p => [{lookup:p.lookup+'_list',cents:p.list*100,monthly:true},{lookup:p.lookup+'_founding',cents:p.founding*100,monthly:true}]), ...[['setup_fu',20000],['setup_va',50000],['setup_aio',65000],['overage_leads',100],['overage_voice_minutes',60]].map(([lookup,cents])=>({lookup,cents,monthly:false}))];
}
function assertPrice(price, expected) {
  if (!price?.active || price.currency !== 'sgd' || price.unit_amount !== expected.cents || price.tax_behavior !== 'exclusive' || (expected.monthly ? price.recurring?.interval !== 'month' || price.recurring?.interval_count !== 1 || price.recurring?.usage_type === 'metered' : Boolean(price.recurring))) throw new Error('Incorrect Stripe price configuration: '+expected.lookup);
}
module.exports = {validSecret,configurationIssues,monthlyPortalParameters,assertMonthlyPortal,expectedPrices,assertPrice};
