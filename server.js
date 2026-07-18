require('dotenv').config();
const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const workspaceRoutes = require('./routes/workspace');
const leadRoutes = require('./routes/leads');
const apolloRoutes = require('./routes/apollo');
const campaignRoutes = require('./routes/campaigns');
const emailRoutes = require('./routes/emails');
const inboxRoutes = require('./routes/inbox');
const callingRoutes = require('./routes/calling');
const aiRoutes = require('./routes/ai');
const retellWebhookRoutes = require('./routes/retellWebhook');
const outcomeRoutes = require('./routes/outcomes');
const { startCallingQueue } = require('./lib/callingQueue');
const { resumeQueuedAgentLaunchJobs } = require('./lib/agentLaunch');
const { apiErrorHandler, apiRequestLogger } = require('./lib/logger');
const { createWorker: createLeadImportWorker } = require('./workers/lead-import.worker');

const app = express();
const PORT = process.env.PORT || 5001;
const frontendOrigin = process.env.FRONTEND_URL || 'http://localhost:3000';
const allowedOrigins = [frontendOrigin, 'http://localhost:3000', 'http://localhost:3001'];

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(apiRequestLogger);
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const origin = req.headers.origin;
  if (!origin || allowedOrigins.includes(origin)) return next();

  return res.status(403).json({ error: 'Invalid request origin' });
});
app.use('/api/retell/webhook', express.raw({ type: 'application/json', limit: '1mb' }), retellWebhookRoutes);
app.use(express.json({ limit: '10mb' }));

app.use('/api/auth', authRoutes);
app.use('/api/workspace', workspaceRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/apollo', apolloRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/emails', emailRoutes);
app.use('/api/inbox', inboxRoutes);
app.use('/api/calling', callingRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/outcomes', outcomeRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use(apiErrorHandler);

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  const runLeadWorkerInProcess = process.env.LEAD_IMPORT_WORKER_ENABLED === 'true'
    || (process.env.LEAD_IMPORT_WORKER_ENABLED !== 'false' && process.env.NODE_ENV !== 'production');
  if (runLeadWorkerInProcess) {
    try {
      createLeadImportWorker();
      console.log('[lead-import-worker] running in this process');
    } catch (error) {
      console.error('[lead-import-worker] failed to start', error.message);
    }
  } else {
    console.log('[lead-import-worker] in-process worker disabled');
  }
  startCallingQueue();
  resumeQueuedAgentLaunchJobs().catch(error => {
    console.error('[agent-launch-recovery] failed', error);
  });
});
