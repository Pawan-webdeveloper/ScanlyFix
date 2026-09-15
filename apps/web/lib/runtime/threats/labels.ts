/**
 * What each attack means, and what to do about it.
 *
 * The feed's job is not to prove we detected something. It is to leave the
 * reader knowing one of two things: "this bounced off, here is why I am
 * relaxed", or "this is the thing to go and fix now". Every entry therefore
 * carries an action, and the actions are specific to the attack rather than
 * "review your security posture".
 *
 * Written for someone who ships with an AI assistant and has never read an OWASP
 * page. No jargon goes unexplained, and nothing is described as worse than it is.
 */

export type ThreatSeverity = 'critical' | 'high' | 'medium';

/** How far back the console looks by default. */
export const WINDOW_HOURS = 24;
/**
 * The window the brute-force rollup correlates over.
 *
 * Short on purpose. Twenty sign-ins from one address in half an hour is a
 * pattern; the same twenty spread over a day is an office.
 */
export const AUTH_WINDOW_MINUTES = 30;

export type ThreatMeta = {
  label: string;
  /** One sentence: what the attacker was trying to do. */
  meaning: string;
  /** One sentence: what to do about it. */
  action: string;
};

const UNKNOWN_META: ThreatMeta = {
  label: 'Unrecognised attack',
  meaning: 'This was recorded by a newer version of the detector than this page knows about.',
  action: 'No action needed here — reload the page after the next deploy to see the full description.',
};

const META: Record<string, ThreatMeta> = {
  sql_injection: {
    label: 'Database break-in attempt',
    meaning:
      'Someone sent database commands inside a normal-looking field, trying to make your app run them and hand back data it should never return.',
    action:
      'Make sure every database call uses parameters or your ORM rather than string-concatenated SQL. If you built this route with an AI assistant, that is the line to check first.',
  },
  nosql_injection: {
    label: 'Database break-in attempt (NoSQL)',
    meaning:
      'Someone sent MongoDB-style query operators in a field that should hold plain text, trying to turn a login check into a match-anything query.',
    action:
      'Reject objects where you expect strings — a login that receives {"$ne": null} instead of a password must fail, not match every user.',
  },
  xss: {
    label: 'Malicious code injection',
    meaning:
      'Someone tried to get JavaScript of theirs to run inside your page, which is how session cookies and logged-in actions get stolen from your real users.',
    action:
      'Never render user input with dangerouslySetInnerHTML, and keep it out of href and src attributes. React escapes text by default — the risk is where you opted out.',
  },
  path_traversal: {
    label: 'File access attempt',
    meaning:
      'Someone tried to climb out of the folder your app serves files from, to read things like server config or password files.',
    action:
      'Resolve any user-supplied filename to an absolute path and confirm it still sits inside the intended directory before opening it.',
  },
  command_injection: {
    label: 'Server command execution attempt',
    meaning:
      'Someone tried to append shell commands to something your server runs, which would give them the ability to run code on your machine.',
    action:
      'Avoid passing user input to exec or a shell at all. Where you must, use an argument array rather than a command string so nothing can be appended.',
  },
  code_injection: {
    label: 'Remote code execution attempt',
    meaning:
      'A payload aimed at a known remote-code bug — Log4Shell-style lookups or prototype pollution — that turns a logged string into code the server runs.',
    action:
      'These are mass scans. You are fine if your dependencies are current; if you merge user objects into your own, guard against __proto__ and constructor keys.',
  },
  template_injection: {
    label: 'Template injection attempt',
    meaning:
      'Someone sent an expression like {{7*7}} to see whether your server evaluates what users type, which is a step away from running their code.',
    action: 'Pass user input to templates as data, never by building the template string out of it.',
  },
  ssrf: {
    label: 'Internal network probe',
    meaning:
      'Someone tried to make your server fetch a URL of their choosing — usually the cloud metadata endpoint, which hands out your deployment credentials.',
    action:
      'If your app fetches URLs users supply, allowlist the hosts. Reject private ranges, localhost, and 169.254.169.254 outright.',
  },
  secret_probe: {
    label: 'Config and secret hunting',
    meaning:
      'An automated sweep for files that are famous for leaking credentials — .env, .git, database dumps, admin panels.',
    action:
      'Nothing to fix if these return 404, which is the normal case on a Next.js app. Confirm no such file is deployed, and treat a 200 as an emergency.',
  },
  scanner: {
    label: 'Vulnerability scanner',
    meaning:
      'A security scanning tool identified itself in the request. Someone is mapping your site looking for a way in.',
    action:
      'Reconnaissance rather than a breach. Worth watching the same address for what it tries next; block it at your CDN if it becomes noisy.',
  },
  brute_force: {
    label: 'Password guessing',
    meaning:
      'One address is working through sign-in attempts far faster than a person could, trying passwords until one lands.',
    action:
      'Rate-limit sign-ins per address and per account, and lock an account after repeated failures. Block the address at your CDN if it continues.',
  },
  auth_attempt: {
    label: 'Sign-in attempt',
    meaning: 'A sign-in was attempted. On its own this is normal traffic, recorded only so bursts can be spotted.',
    action: 'None.',
  },
  auth_failure: {
    label: 'Failed sign-in',
    meaning: 'Your application reported that a sign-in failed. On its own this is normal, recorded only so bursts can be spotted.',
    action: 'None.',
  },
};

export const threatMeta = (kind: string): ThreatMeta => META[kind] ?? UNKNOWN_META;

/** Where in the request the payload sat, in words. */
export const surfaceLabel = (surface: string): string =>
  ({
    path: 'in the URL path',
    query: 'in a query parameter',
    header: 'in a request header',
    user_agent: 'in the user agent',
  })[surface] ?? 'in the request';

export const SEVERITY_RANK: Readonly<Record<string, number>> = { critical: 0, high: 1, medium: 2 };

