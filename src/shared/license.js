// Licence state, without I/O: a trial from the first run, then a licence key (Lemon Squeezy) that is
// re-validated online now and then and keeps working offline for a while.
export const TRIAL_DAYS = 14;
export const RECHECK_DAYS = 7; // re-validate an activated key this often
export const OFFLINE_DAYS = 30; // an activated key keeps working this long without reaching the server
const DAY = 86400000;

/**
 * @param {{firstRun?: number, lastSeen?: number, key?: string, instanceId?: string, validatedAt?: number, revoked?: boolean}} state
 * @returns {{mode: 'licensed'|'trial'|'expired', reason?: string, daysLeft?: number, needsCheck?: boolean}}
 */
export function licenseStatus(state, now = Date.now()) {
  if (state.key && state.instanceId) {
    if (state.revoked) return { mode: 'expired', reason: 'revoked' };
    const age = now - (state.validatedAt ?? 0);
    if (age <= OFFLINE_DAYS * DAY && age >= -DAY) return { mode: 'licensed', needsCheck: age > RECHECK_DAYS * DAY };
    return { mode: 'expired', reason: 'offline', needsCheck: true };
  }
  // A clock set back more than a day before the last start ends the trial.
  if (state.lastSeen && now < state.lastSeen - DAY) return { mode: 'expired', reason: 'clock' };
  const start = state.firstRun ?? now;
  const daysLeft = Math.ceil((start + TRIAL_DAYS * DAY - now) / DAY);
  return daysLeft > 0 ? { mode: 'trial', daysLeft: Math.min(daysLeft, TRIAL_DAYS) } : { mode: 'expired', reason: 'trial' };
}

/** "38b1460a-5104-…-77b872934d51" -> "••••-4d51" for display. */
export const maskKey = (key) => (key ? `••••-${String(key).slice(-4)}` : '');
