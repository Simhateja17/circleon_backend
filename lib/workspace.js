async function getOrCreateWorkspace(supabase, user) {
  const { data: existing, error: selectError } = await supabase
    .from('workspaces')
    .select('*')
    .eq('owner_id', user.id)
    .maybeSingle();

  if (selectError) throw selectError;
  if (existing) return existing;

  const fallbackName = user.user_metadata?.business_name
    || user.email?.split('@')[0]
    || 'My Workspace';

  const { data, error } = await supabase
    .from('workspaces')
    .insert({
      owner_id: user.id,
      name: fallbackName,
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

module.exports = {
  getOrCreateWorkspace,
};
