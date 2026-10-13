const test = require('node:test');
const assert = require('node:assert/strict');

const {
  callingWindowState,
  nextAttemptAt,
  zonedParts,
} = require('../lib/voiceScheduling');

const {
  classifyPhoneType,
  refinePhoneTypeFromNumber,
  requiresDncCheck,
  summariseCallability,
  voiceEligibility,
  parsePdpcResults,
} = require('../lib/dnc');

const { billableCents } = require('../lib/callCredits');
const { voiceCampaignState, requiresAttestation } = require('../lib/voiceCampaign');

const SG = 'Asia/Singapore';
const campaignSchedule = {
  timezone: SG,
  active_days: [1, 2, 3, 4, 5],
  sending_hours_start: '09:00',
  sending_hours_end: '18:00',
};

// 2026-09-16 is a Wednesday. Singapore is UTC+8 with no DST.
const wedMorningSGT = new Date('2026-09-16T02:00:00Z'); // 10:00 SGT
const wedNightSGT = new Date('2026-09-16T14:00:00Z');   // 22:00 SGT
const satSGT = new Date('2026-09-19T02:00:00Z');        // Sat 10:00 SGT

test('calling window opens inside business hours on an active day', () => {
  const state = callingWindowState(campaignSchedule, wedMorningSGT);
  assert.equal(state.open, true);
  assert.equal(state.reason, null);
});

test('calling window closes outside business hours and explains why', () => {
  const state = callingWindowState(campaignSchedule, wedNightSGT);
  assert.equal(state.open, false);
  assert.match(state.reason, /calling hours/);
});

test('calling window closes on inactive days', () => {
  const state = callingWindowState(campaignSchedule, satSGT);
  assert.equal(state.open, false);
  assert.match(state.reason, /active days/);
});

test('window shuts slightly before the end so a call is not cut off', () => {
  const justBeforeClose = new Date('2026-09-16T09:55:00Z'); // 17:55 SGT
  assert.equal(callingWindowState(campaignSchedule, justBeforeClose).open, false);

  const comfortablyBefore = new Date('2026-09-16T09:30:00Z'); // 17:30 SGT
  assert.equal(callingWindowState(campaignSchedule, comfortablyBefore).open, true);
});

test('retries land in a different part of the day each attempt', () => {
  const first = nextAttemptAt(campaignSchedule, 2, { from: wedMorningSGT, gapHours: 24 });
  const second = nextAttemptAt(campaignSchedule, 3, { from: wedMorningSGT, gapHours: 24 });

  const firstMinutes = zonedParts(first, SG).minutes;
  const secondMinutes = zonedParts(second, SG).minutes;

  assert.notEqual(firstMinutes, secondMinutes);
  // Both inside the 09:00-18:00 window.
  for (const minutes of [firstMinutes, secondMinutes]) {
    assert.ok(minutes >= 540 && minutes < 1080, `expected ${minutes} inside the window`);
  }
  // Later attempt is later in the day.
  assert.ok(secondMinutes > firstMinutes);
});

test('retries respect the minimum gap and skip inactive days', () => {
  // Friday 16:00 SGT, retry a day later would be Saturday.
  const fridayAfternoon = new Date('2026-09-18T08:00:00Z');
  const retry = nextAttemptAt(campaignSchedule, 2, { from: fridayAfternoon, gapHours: 24 });

  assert.ok(retry.getTime() >= fridayAfternoon.getTime() + 24 * 3600 * 1000);
  assert.equal(zonedParts(retry, SG).isoWeekday, 1, 'should skip the weekend to Monday');
});

test('apollo phone fields map to the right type', () => {
  assert.equal(classifyPhoneType('organization_phone').phoneType, 'business');
  assert.equal(classifyPhoneType('mobile_phone').phoneType, 'personal');
  assert.equal(classifyPhoneType('direct_phone').phoneType, 'personal');
  assert.equal(classifyPhoneType('something_else').phoneType, 'unknown');
});

test('singapore numbering firms up an unknown type but never overrides', () => {
  assert.equal(refinePhoneTypeFromNumber('unknown', '+6591234567'), 'personal');
  assert.equal(refinePhoneTypeFromNumber('unknown', '+6562345678'), 'business');
  assert.equal(refinePhoneTypeFromNumber('personal', '+6562345678'), 'personal');
  assert.equal(refinePhoneTypeFromNumber('unknown', '+14155551234'), 'unknown');
});

test('business lines are exempt from the DNC check, personal ones are not', () => {
  assert.equal(requiresDncCheck({ phone_e164: '+6562345678', phone_type: 'business' }), false);
  assert.equal(requiresDncCheck({ phone_e164: '+6591234567', phone_type: 'personal' }), true);
  // Outside the Singapore registry entirely.
  assert.equal(requiresDncCheck({ phone_e164: '+14155551234', phone_type: 'personal' }), false);
});

test('a business line is callable without ever contacting PDPC', () => {
  const result = voiceEligibility({ phone_e164: '+6562345678', phone_type: 'business', dnc_status: 'unknown' });
  assert.equal(result.callable, true);
});

test('a personal number without a check is refused, and says why', () => {
  const result = voiceEligibility({ phone_e164: '+6591234567', phone_type: 'personal', dnc_status: 'unknown' });
  assert.equal(result.callable, false);
  assert.match(result.reason, /Do Not Call check/);
});

test('DNC clearance expires after 30 days', () => {
  const lead = {
    phone_e164: '+6591234567',
    phone_type: 'personal',
    dnc_status: 'clear',
    dnc_checked_at: '2026-08-01T00:00:00Z',
  };
  const result = voiceEligibility(lead, new Date('2026-09-16T00:00:00Z'));
  assert.equal(result.callable, false);
  assert.match(result.reason, /expired/);

  const fresh = voiceEligibility({ ...lead, dnc_checked_at: '2026-09-10T00:00:00Z' }, new Date('2026-09-16T00:00:00Z'));
  assert.equal(fresh.callable, true);
});

test('a do-not-call lead is never callable', () => {
  const result = voiceEligibility({ phone_e164: '+6562345678', phone_type: 'business', status: 'do_not_call' });
  assert.equal(result.callable, false);
});

test('callability summary tells the user what they are actually getting', () => {
  const summary = summariseCallability([
    { phone_e164: '+6562345678', phone_type: 'business' },
    { phone_e164: '+6562345679', phone_type: 'business' },
    { phone_e164: '+6591234567', phone_type: 'personal' },
    { phone_e164: '+6591234568', phone_type: 'personal', dnc_status: 'blocked' },
    { email: 'no-phone@example.com' },
  ]);

  assert.equal(summary.total, 5);
  assert.equal(summary.withPhone, 4);
  assert.equal(summary.business, 2);
  assert.equal(summary.callableNow, 2);
  assert.equal(summary.needsDncCheck, 1);
  assert.equal(summary.blocked, 1);
});

test('unparsed PDPC responses fail closed rather than open', () => {
  const results = parsePdpcResults({}, ['+6591234567']);
  assert.equal(results[0].status, 'unknown');

  const listed = parsePdpcResults({ results: [{ number: '+6591234567', listed: true }] }, ['+6591234567']);
  assert.equal(listed[0].status, 'blocked');

  const clear = parsePdpcResults({ results: [{ number: '+6591234567', listed: false }] }, ['+6591234567']);
  assert.equal(clear[0].status, 'clear');
});

test('unanswered calls do not consume credit by default', () => {
  const unanswered = { status: 'no_answer', duration_seconds: 0, cost_cents: 3 };
  assert.equal(billableCents(unanswered), 0);

  const connected = { status: 'completed', duration_seconds: 95, cost_cents: 20 };
  assert.ok(billableCents(connected) > 0);
});

test('non-english scripts require an attestation', () => {
  assert.equal(requiresAttestation('en-US'), false);
  assert.equal(requiresAttestation('en-SG'), false);
  assert.equal(requiresAttestation('zh-CN'), true);
});

test('a campaign waiting on number verification reports waiting, not broken', () => {
  const state = voiceCampaignState({
    campaign: { status: 'active', ...campaignSchedule, daily_send_cap: 50 },
    script: { status: 'approved', opening_line: 'Hi there', language: 'en-US' },
    agent: { status: 'ready', retell_agent_id: 'agent_1' },
    telephony: { phone_number_status: 'pending_verification', max_concurrent_calls: 1 },
  }, wedMorningSGT);

  assert.equal(state.ready, false);
  assert.equal(state.state, 'waiting_on_setup');
  assert.match(state.reason, /Twilio/);
});

test('a fully configured campaign inside its window dials', () => {
  const state = voiceCampaignState({
    campaign: { status: 'active', ...campaignSchedule, daily_send_cap: 50 },
    script: { status: 'approved', opening_line: 'Hi there', language: 'en-US' },
    agent: { status: 'ready', retell_agent_id: 'agent_1' },
    telephony: { phone_number_status: 'verified', max_concurrent_calls: 1 },
    callsToday: 3,
    activeCalls: 0,
    creditBalanceCents: 5000,
    pendingTargets: 12,
  }, wedMorningSGT);

  assert.equal(state.dialing, true);
  assert.equal(state.state, 'dialing');
});

test('a campaign out of credits says so rather than stalling silently', () => {
  const state = voiceCampaignState({
    campaign: { status: 'active', ...campaignSchedule, daily_send_cap: 50 },
    script: { status: 'approved', opening_line: 'Hi there', language: 'en-US' },
    agent: { status: 'ready', retell_agent_id: 'agent_1' },
    telephony: { phone_number_status: 'verified', max_concurrent_calls: 1 },
    callsToday: 0,
    activeCalls: 0,
    creditBalanceCents: 0,
    pendingTargets: 12,
  }, wedMorningSGT);

  assert.equal(state.dialing, false);
  assert.equal(state.state, 'out_of_credits');
});

test('the daily cap stops a campaign and names the reason', () => {
  const state = voiceCampaignState({
    campaign: { status: 'active', ...campaignSchedule, daily_send_cap: 25 },
    script: { status: 'approved', opening_line: 'Hi there', language: 'en-US' },
    agent: { status: 'ready', retell_agent_id: 'agent_1' },
    telephony: { phone_number_status: 'verified', max_concurrent_calls: 1 },
    callsToday: 25,
    activeCalls: 0,
    creditBalanceCents: 5000,
    pendingTargets: 12,
  }, wedMorningSGT);

  assert.equal(state.state, 'daily_cap');
});
