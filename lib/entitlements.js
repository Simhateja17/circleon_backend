// What each subscription unlocks. The plan catalogue (pricing.json) is the
// source of truth: every plan lists its features, so the backend and the
// workspace UI gate the same things.
const { byId } = require('./pricing');
const { getBilling, isActiveSubscription } = require('./billing');
const { getOrCreateWorkspace } = require('./workspace');

const FEATURES = ['leads', 'email', 'invoices', 'voice'];
// Pre-monthly (atelier, maison, sovereign) workspaces keep what they had before
// plan families existed. Invoicing is newer than them, so it is not included.
const LEGACY_FEATURES = ['leads', 'email', 'voice'];

function planFeatures(planId) {
  if (!planId) return [];
  const plan = byId[planId];
  return plan ? plan.features : LEGACY_FEATURES;
}

function hasFeature(planId, feature) {
  return planFeatures(planId).includes(feature);
}

// The cheapest current plan that includes a feature, for upgrade prompts.
function upgradePlanFor(feature) {
  return { invoices: 'email_invoice', voice: 'all_in_one' }[feature] || 'email';
}

/** Express middleware: 402 without an active plan, 403 when the plan lacks the feature. */
function requireFeature(feature) {
  if (!FEATURES.includes(feature)) throw new Error(`Unknown feature: ${feature}`);
  return async (req, res, next) => {
    try {
      const workspace = await getOrCreateWorkspace(req.supabase, req.user);
      const billing = await getBilling(req.supabase, workspace.id);
      if (!isActiveSubscription(billing)) {
        return res.status(402).json({ error: 'An active subscription is required before using this feature.' });
      }
      if (!hasFeature(billing.plan, feature)) {
        return res.status(403).json({
          error: 'Your plan does not include this feature. Upgrade to unlock it.',
          feature,
          upgradePlan: upgradePlanFor(feature),
        });
      }
      req.workspace = workspace;
      req.billing = billing;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = { FEATURES, planFeatures, hasFeature, upgradePlanFor, requireFeature };
