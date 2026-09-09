const test = require('node:test');
const assert = require('node:assert/strict');

const { applyTourPatch, normalizeTourState } = require('../lib/tourState');

const NOW = new Date('2026-09-06T10:00:00.000Z');

test('a missing record normalises to not_started so existing users get the tour once', () => {
  assert.deepEqual(normalizeTourState(undefined), {
    status: 'not_started',
    lastStepId: null,
    lastStepIndex: 0,
    seenStepIds: [],
    updatedAt: null,
  });
  assert.equal(normalizeTourState({}).status, 'not_started');
  assert.equal(normalizeTourState({ status: 'nonsense' }).status, 'not_started');
  assert.equal(normalizeTourState([]).status, 'not_started');
  assert.equal(normalizeTourState({ lastStepIndex: -4 }).lastStepIndex, 0);
});

test('a partial patch leaves the untouched fields alone and stamps updatedAt', () => {
  const current = { status: 'in_progress', lastStepId: 'add-leads', lastStepIndex: 2, seenStepIds: ['welcome'] };

  const next = applyTourPatch(current, { lastStepIndex: 3, lastStepId: 'leads-verified' }, NOW);

  assert.equal(next.status, 'in_progress');
  assert.equal(next.lastStepId, 'leads-verified');
  assert.equal(next.lastStepIndex, 3);
  assert.deepEqual(next.seenStepIds, ['welcome']);
  assert.equal(next.updatedAt, '2026-09-06T10:00:00.000Z');
});

test('seenStepIds union, so a stale write cannot erase steps another tab recorded', () => {
  const current = { status: 'in_progress', seenStepIds: ['welcome', 'connect-mailbox'] };

  const next = applyTourPatch(current, { seenStepIds: ['add-leads', 'welcome'] }, NOW);

  assert.deepEqual(next.seenStepIds, ['welcome', 'connect-mailbox', 'add-leads']);
});

test('a restart clears the history instead of unioning it', () => {
  const current = { status: 'completed', lastStepId: 'finish', lastStepIndex: 12, seenStepIds: ['welcome', 'finish'] };

  const next = applyTourPatch(current, { status: 'in_progress', lastStepIndex: 0, lastStepId: 'welcome', seenStepIds: [], restart: true }, NOW);

  assert.equal(next.status, 'in_progress');
  assert.equal(next.lastStepIndex, 0);
  assert.deepEqual(next.seenStepIds, []);
});

test('junk in a patch is ignored rather than written through', () => {
  const current = { status: 'in_progress', lastStepId: 'add-leads', lastStepIndex: 2, seenStepIds: [] };

  const next = applyTourPatch(current, { status: 'nonsense', lastStepIndex: -1, seenStepIds: 'nope' }, NOW);

  assert.equal(next.status, 'in_progress');
  assert.equal(next.lastStepIndex, 2);
  assert.deepEqual(next.seenStepIds, []);
});
