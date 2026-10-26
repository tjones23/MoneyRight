/**
 * What makes a password acceptable — kept apart from password.ts, which
 * needs node:crypto, so the sign-up forms can show the same rule.
 */

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

/** A reason the password won't do, or null. Length is the rule that matters. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  return null;
}
