/**
 * "Needs a session" rule — CheckVibe ka exact idea:
 * real traffic lagbhag HAMESHA session ke saath aaya → route protected hai.
 */

/** 5% tolerance — ek-ok-luck logged-out request false signal nahi banegi. */
export const NEEDS_SESSION_MAX_OPEN_RATIO = 0.05;
/** 3 se kam samples = data nahi hai, guess mat karo. */
export const NEEDS_SESSION_MIN_SAMPLES = 3;

export function computeNeedsSession(withSession: number, withoutSession: number): boolean {
  const total = withSession + withoutSession;
  if (total < NEEDS_SESSION_MIN_SAMPLES) return false;
  return withoutSession / total <= NEEDS_SESSION_MAX_OPEN_RATIO;
}