const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);

function isActiveSubscription(billing) {
  return Boolean(billing && ACTIVE_SUBSCRIPTION_STATUSES.has(billing.subscription_status));
}

async function getBilling(supabase, workspaceId) {
  const { data, error } = await supabase
    .from('workspace_billing')
    .select('*')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function requireActiveSubscription(req, res, workspace) {
  const billing = await getBilling(req.supabase, workspace.id);
  if (!isActiveSubscription(billing)) {
    res.status(402).json({
      error: 'An active paid subscription is required before using this feature.',
      billing: billing || { subscription_status: 'inactive' },
    });
    return null;
  }
  return billing;
}

module.exports = { ACTIVE_SUBSCRIPTION_STATUSES, getBilling, isActiveSubscription, requireActiveSubscription };
