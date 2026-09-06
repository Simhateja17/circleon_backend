/**
 * Guided tour progress: normalising a stored record and applying a partial
 * patch to it.
 *
 * Both functions are pure so the merge rules — which are the only part with any
 * behaviour in them — can be tested without a database. The route module does
 * nothing but read the row, call applyTourPatch, and write it back.
 */

const TOUR_STATUSES = new Set(['not_started', 'in_progress', 'completed', 'skipped']);

const MAX_SEEN_STEP_IDS = 200;
const MAX_STEP_ID_LENGTH = 80;

/**
 * A missing or malformed record reads as not_started, so an existing workspace
 * that predates this column gets the tour exactly once, the same as a new one.
 */
function normalizeTourState(value) {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {};

  const status = TOUR_STATUSES.has(record.status) ? record.status : 'not_started';
  const lastStepId = typeof record.lastStepId === 'string' && record.lastStepId
    ? record.lastStepId.slice(0, MAX_STEP_ID_LENGTH)
    : null;
  const lastStepIndex = Number.isFinite(record.lastStepIndex) && record.lastStepIndex >= 0
    ? Math.trunc(record.lastStepIndex)
    : 0;
  const seenStepIds = Array.isArray(record.seenStepIds)
    ? [...new Set(record.seenStepIds.filter(id => typeof id === 'string' && id).map(id => id.slice(0, MAX_STEP_ID_LENGTH)))].slice(-MAX_SEEN_STEP_IDS)
    : [];
  const updatedAt = typeof record.updatedAt === 'string' && record.updatedAt ? record.updatedAt : null;

  return { status, lastStepId, lastStepIndex, seenStepIds, updatedAt };
}

/**
 * Merge a partial patch into the current record and stamp updatedAt.
 *
 * seenStepIds is unioned rather than replaced: the client sends only the step
 * it just reached, and two tabs (or a slow request that lands out of order)
 * must not be able to erase steps the other one recorded.
 */
function applyTourPatch(current, patch, now = new Date()) {
  const base = normalizeTourState(current);
  const incoming = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};

  const next = { ...base };

  if (TOUR_STATUSES.has(incoming.status)) {
    next.status = incoming.status;
  }

  if (incoming.lastStepId === null) {
    next.lastStepId = null;
  } else if (typeof incoming.lastStepId === 'string' && incoming.lastStepId) {
    next.lastStepId = incoming.lastStepId.slice(0, MAX_STEP_ID_LENGTH);
  }

  if (Number.isFinite(incoming.lastStepIndex) && incoming.lastStepIndex >= 0) {
    next.lastStepIndex = Math.trunc(incoming.lastStepIndex);
  }

  if (incoming.restart === true) {
    // Replaying the tour from the start is the one case where the history is
    // meant to be cleared, so a restart replaces rather than unions.
    next.seenStepIds = Array.isArray(incoming.seenStepIds)
      ? [...new Set(incoming.seenStepIds.filter(id => typeof id === 'string' && id).map(id => id.slice(0, MAX_STEP_ID_LENGTH)))].slice(-MAX_SEEN_STEP_IDS)
      : [];
  } else if (Array.isArray(incoming.seenStepIds)) {
    const merged = [
      ...base.seenStepIds,
      ...incoming.seenStepIds.filter(id => typeof id === 'string' && id).map(id => id.slice(0, MAX_STEP_ID_LENGTH)),
    ];
    next.seenStepIds = [...new Set(merged)].slice(-MAX_SEEN_STEP_IDS);
  }

  next.updatedAt = now.toISOString();

  return next;
}

module.exports = {
  TOUR_STATUSES,
  applyTourPatch,
  normalizeTourState,
};
