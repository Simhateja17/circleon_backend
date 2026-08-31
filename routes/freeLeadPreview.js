const express = require('express');
const { createServiceClient } = require('../lib/supabase');
const {
  enqueueFreeLeadPreview,
  normalizePreviewInput,
} = require('../lib/freeLeadPreview');

const router = express.Router();
const IP_WINDOW_MS = 60 * 60 * 1000;
function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const IP_MAX_REQUESTS = positiveNumber(process.env.FREE_LEAD_PREVIEW_IP_MAX, 10);
const EMAIL_COOLDOWN_MS = positiveNumber(process.env.FREE_LEAD_PREVIEW_EMAIL_COOLDOWN_MS, 24 * 60 * 60 * 1000);
const ipRequests = new Map();

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function allowIp(ip, now = Date.now()) {
  const previous = ipRequests.get(ip) || [];
  const current = previous.filter(timestamp => now - timestamp < IP_WINDOW_MS);
  if (current.length >= IP_MAX_REQUESTS) {
    ipRequests.set(ip, current);
    return false;
  }
  current.push(now);
  ipRequests.set(ip, current);
  if (ipRequests.size > 10000) {
    for (const [key, timestamps] of ipRequests) {
      if (!timestamps.some(timestamp => now - timestamp < IP_WINDOW_MS)) ipRequests.delete(key);
    }
  }
  return true;
}

async function recentRequest(service, email, cutoff) {
  const { data, error } = await service
    .from('free_lead_preview_requests')
    .select('id,status,created_at')
    .eq('email', email)
    .gte('created_at', cutoff)
    .in('status', ['queued', 'searching', 'enriching', 'sending', 'sent', 'partial'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

router.post('/', async (req, res) => {
  const input = normalizePreviewInput(req.body || {});
  if (!input.valid) {
    return res.status(400).json({
      ok: false,
      error: 'Please answer all five targeting questions and provide a valid work email.',
      fields: input.errors,
    });
  }

  const ip = clientIp(req);
  if (!allowIp(ip)) {
    return res.status(429).json({ ok: false, error: 'Please try again later.' });
  }

  const service = createServiceClient();
  if (!service) {
    return res.status(503).json({ ok: false, error: 'The lead preview is temporarily unavailable.' });
  }

  try {
    const cutoff = new Date(Date.now() - EMAIL_COOLDOWN_MS).toISOString();
    const existing = await recentRequest(service, input.email, cutoff);
    if (existing) {
      return res.status(409).json({
        ok: false,
        error: existing.status === 'sent' || existing.status === 'partial'
          ? 'A recent lead preview was already sent to this email. Please check your inbox.'
          : 'A lead preview is already being prepared for this email.',
      });
    }

    const { data: request, error } = await service
      .from('free_lead_preview_requests')
      .insert({
        email: input.email,
        company_name: input.companyName,
        product: input.product,
        target_titles: input.titles,
        target_industry: input.industry,
        target_region: input.region,
        target_company_size: input.companySize,
        requested_count: 3,
        status: 'queued',
      })
      .select('id,status,created_at')
      .single();
    if (error) throw error;

    try {
      await enqueueFreeLeadPreview(request.id);
    } catch (queueError) {
      await service.from('free_lead_preview_requests').update({
        status: 'failed',
        error_message: queueError.message || 'Could not queue preview',
        completed_at: new Date().toISOString(),
      }).eq('id', request.id);
      throw queueError;
    }

    return res.status(202).json({ ok: true, queued: true, requestId: request.id });
  } catch (error) {
    if (error?.code === '23505') {
      return res.status(409).json({ ok: false, error: 'A lead preview is already being prepared for this email.' });
    }
    console.error(JSON.stringify({
      event: 'free_lead_preview_request_failed',
      ip,
      error: error.message || 'Unknown error',
    }));
    return res.status(500).json({ ok: false, error: 'The lead preview could not be started.' });
  }
});

module.exports = router;
module.exports.allowIp = allowIp;
module.exports.normalizePreviewInput = normalizePreviewInput;
