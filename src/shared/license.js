// Licence state, without I/O: an open beta (until a date), then a licence key (Lemon Squeezy) that is
// re-validated online now and then and keeps working offline for a while. Newcomers after the beta get a
// trial first; beta testers get a discount instead.
export const TRIAL_DAYS = 14;
export const RECHECK_DAYS = 7; // re-validate an activated key this often
export const OFFLINE_DAYS = 30; // an activated key keeps working this long without reaching the server
const DAY = 86400000;

/**
 * @param {{firstRun?: number, lastSeen?: number, key?: string, keyKind?: 'beta'|'lifetime', instanceId?: string, validatedAt?: number, revoked?: boolean}} state
 * @param {{betaEndsAt?: number|null, betaKeyRequired?: boolean}} [opts]
 *   betaEndsAt: end of the open beta (ms); betaKeyRequired: the beta needs a (free) beta key
 * @returns {{mode: 'licensed'|'beta'|'trial'|'expired', reason?: string, daysLeft?: number, needsCheck?: boolean, betaTester?: boolean, registered?: boolean}}
 */
export function licenseStatus(state, now = Date.now(), { betaEndsAt = null, betaKeyRequired = false } = {}) {
  const inBeta = !!betaEndsAt && now < betaEndsAt;
  const betaTester = state.keyKind === 'beta' || (!!betaEndsAt && (state.firstRun ?? now) < betaEndsAt);
  // A clock set back more than a day before the last start ends the beta / trial.
  const clockBack = state.lastSeen && now < state.lastSeen - DAY;
  if (state.key && state.instanceId) {
    if (state.revoked) return { mode: 'expired', reason: 'revoked', betaTester };
    const age = now - (state.validatedAt ?? 0);
    if (age > OFFLINE_DAYS * DAY || age < -DAY) return { mode: 'expired', reason: 'offline', needsCheck: true, betaTester };
    if (state.keyKind === 'beta') {
      if (clockBack) return { mode: 'expired', reason: 'clock', betaTester };
      return inBeta ? { mode: 'beta', daysLeft: Math.ceil((betaEndsAt - now) / DAY), registered: true, needsCheck: age > RECHECK_DAYS * DAY }
        : { mode: 'expired', reason: 'betaOver', betaTester: true };
    }
    return { mode: 'licensed', needsCheck: age > RECHECK_DAYS * DAY };
  }
  if (clockBack) return { mode: 'expired', reason: 'clock', betaTester };
  if (inBeta) return betaKeyRequired ? { mode: 'expired', reason: 'betaKey' } : { mode: 'beta', daysLeft: Math.ceil((betaEndsAt - now) / DAY) };
  // After the beta: testers buy (with their discount); newcomers get the trial from their first run.
  if (betaTester) return { mode: 'expired', reason: 'betaOver', betaTester: true };
  const daysLeft = Math.ceil(((state.firstRun ?? now) + TRIAL_DAYS * DAY - now) / DAY);
  return daysLeft > 0 ? { mode: 'trial', daysLeft: Math.min(daysLeft, TRIAL_DAYS) } : { mode: 'expired', reason: 'trial' };
}

/** "38b1460a-5104-…-77b872934d51" -> "••••-4d51" for display. */
export const maskKey = (key) => (key ? `••••-${String(key).slice(-4)}` : '');
