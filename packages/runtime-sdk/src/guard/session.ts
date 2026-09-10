/**
 * PROMISE (CheckVibe parity): hum dekhte hain session cookie MAUJOOD hai ya nahi —
 * usme KYA hai wo KABHI nahi dekhte. Sirf cookie NAMES match hote hain.
 */

export const DEFAULT_SESSION_COOKIE_PATTERNS: ReadonlyArray<RegExp> = [
  /^sb-[\w-]+-auth-token(\.\d+)?$/,        // Supabase (+ chunked .0/.1 variants)
  /^next-auth\.session-token(\.\d+)?$/,    // NextAuth v4 (+ __Secure-)
  /^__Secure-next-auth\.session-token(\.\d+)?$/,
  /^authjs\.session-token(\.\d+)?$/,       // Auth.js v5 (+ __Secure-)
  /^__Secure-authjs\.session-token(\.\d+)?$/,
  /^__session$/,                           // Firebase Auth
  /^connect\.sid$/,                        // Express sessions
];

export type SessionDetectionOptions = {
  /** User ke apne exact cookie naam (jaise "my-session"). */
  extraCookieNames?: ReadonlyArray<string>;
};

export function hasSessionCookie(
  cookieHeader: string | null | undefined,
  opts: SessionDetectionOptions = {},
): boolean {
  if (!cookieHeader) return false;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    const name = (eq === -1 ? part : part.slice(0, eq)).trim();
    if (name.length === 0) continue;
    if (opts.extraCookieNames?.includes(name)) return true;
    if (DEFAULT_SESSION_COOKIE_PATTERNS.some((re) => re.test(name))) return true;
    // ⭐ value par kabhi touch nahi kiya — ye line khud uska proof hai
  }
  return false;
}