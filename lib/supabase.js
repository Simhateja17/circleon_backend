const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Realtime is disabled because this backend does not use Supabase realtime
// subscriptions and Node.js 20 lacks native WebSocket support.
const clientOptions = {
  realtime: { enabled: false },
};

const supabase = createClient(supabaseUrl, supabaseAnonKey, clientOptions);

function createAuthedClient(accessToken) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    ...clientOptions,
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}

function createServiceClient() {
  if (!supabaseServiceRoleKey) return null;
  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    ...clientOptions,
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

module.exports = supabase;
module.exports.createAuthedClient = createAuthedClient;
module.exports.createServiceClient = createServiceClient;
