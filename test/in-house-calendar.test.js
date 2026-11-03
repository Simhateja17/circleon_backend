const test = require('node:test');
const assert = require('node:assert/strict');
const { findOpenSlots } = require('../lib/inHouseCalendar');

function fakeDb(meetings = []) {
  const query = { select: () => query, eq: () => query, in: () => query, gte: () => query, lt: () => query, then: resolve => resolve({ data: meetings, error: null }) };
  return { from: () => query };
}
const campaign = { timezone: 'Asia/Singapore', sending_hours_start: '09:00:00', sending_hours_end: '18:00:00', active_days: [1, 2, 3, 4, 5] };
// Tuesday 3 Nov 2026, 00:24 in Singapore is 16:24 UTC on the 2nd.
const now = new Date('2026-11-02T16:24:00Z');
const find = (meetings, options = {}) => findOpenSlots(fakeDb(meetings), { workspaceId: 'w', campaign, now, ...options });

test('offers one time a day, from the start of the calling hours', async () => {
  const slots = await find([]);
  assert.deepEqual(slots.map(slot => slot.start), ['2026-11-03T01:00:00.000Z', '2026-11-04T01:00:00.000Z', '2026-11-05T01:00:00.000Z']);
  assert.equal(slots[0].end, '2026-11-03T01:30:00.000Z');
  assert.match(slots[0].spoken, /Tuesday/);
});

test('skips a time that is already booked', async () => {
  const [first] = await find([{ starts_at: '2026-11-03T01:00:00Z', ends_at: '2026-11-03T01:30:00Z' }]);
  assert.equal(first.start, '2026-11-03T01:30:00.000Z');
});

test('treats a booking with no end time as a full slot', async () => {
  const [first] = await find([{ starts_at: '2026-11-03T01:00:00Z', ends_at: null }]);
  assert.equal(first.start, '2026-11-03T01:30:00.000Z');
});

test('never offers a time within the next hour', async () => {
  const [first] = await find([], { now: new Date('2026-11-03T01:10:00Z') });
  assert.equal(first.start, '2026-11-03T02:30:00.000Z');
});

test('skips days the campaign does not call', async () => {
  const slots = await find([], { now: new Date('2026-11-06T12:00:00Z'), limit: 1 });
  assert.equal(slots[0].start, '2026-11-09T01:00:00.000Z');
});

test('falls back to weekdays, 9 to 6, with no campaign', async () => {
  const [first] = await find([], { campaign: null });
  assert.equal(first.start, '2026-11-03T01:00:00.000Z');
});

test('can offer several times a day for the booking page', async () => {
  const slots = await find([], { days: 1, limit: 10, perDay: 3 });
  assert.deepEqual(slots.map(slot => slot.start), ['2026-11-03T01:00:00.000Z', '2026-11-03T01:30:00.000Z', '2026-11-03T02:00:00.000Z']);
});
