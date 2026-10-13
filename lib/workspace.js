async function getOrCreateWorkspace(supabase, user) {
  const { data: member, error: memberError } = await supabase.from('workspace_members').select('workspace_id').eq('user_id',user.id).eq('status','active').maybeSingle();
  // Before the pricing migration exists, preserve the legacy owner flow.
  if (memberError && !['42P01','PGRST205'].includes(memberError.code)) throw memberError;
  if (member) {
    const {data: workspace,error}=await supabase.from('workspaces').select('*').eq('id',member.workspace_id).single();
    if(error) throw error; return workspace;
  }
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
