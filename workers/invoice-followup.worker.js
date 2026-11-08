// Sends payment reminders and post-sale check-ins. Run exactly one instance in
// production (npm run worker:invoices); in development it runs inside server.js.
require('dotenv').config();
const { createServiceClient } = require('../lib/supabase');
const { runInvoiceFollowUps } = require('../lib/invoices');

const INTERVAL_MS = Number(process.env.INVOICE_WORKER_INTERVAL_MS || 15 * 60 * 1000);

function startInvoiceFollowUps() {
  const db = createServiceClient();
  if (!db) {
    console.error('[invoice-followup-worker] SUPABASE_SERVICE_ROLE_KEY is required; not started');
    return null;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const { sent } = await runInvoiceFollowUps(db);
      if (sent) console.log(`[invoice-followup-worker] sent ${sent} follow-up email(s)`);
    } catch (error) {
      console.error('[invoice-followup-worker]', error.message);
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, INTERVAL_MS);
}

if (require.main === module) startInvoiceFollowUps();

module.exports = { startInvoiceFollowUps };
