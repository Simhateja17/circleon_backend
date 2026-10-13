const plans = require('../pricing.json');
const byId = Object.fromEntries(plans.map(plan => [plan.id, plan]));
const WEBMAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'yahoo.co.uk', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'mail.com']);
function companyDomain(email) {
  const domain = String(email || '').trim().toLowerCase().split('@')[1];
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new Error('A verified work email is required.');
  return domain;
}
function limits(billing) {
  const plan = byId[billing?.plan];
  if (!plan) return null; // Preserve the legacy subscription contract.
  const trial = billing.subscription_status === 'trialing';
  return { ...plan, leads: trial ? 50 : plan.leads, emails: trial ? 200 : plan.emails, minutes: trial ? 0 : plan.minutes, trial };
}
function voiceOverageCents(seconds, includedMinutes) {
  return Math.max(0, Math.ceil(Number(seconds || 0) / 60) - includedMinutes) * 60;
}
function invoiceSubscription(invoice) {
  const value = invoice.subscription || invoice.parent?.subscription_details?.subscription;
  return typeof value === 'object' ? value?.id : value;
}
module.exports = { plans, byId, WEBMAIL, companyDomain, limits, voiceOverageCents, invoiceSubscription };
