/**
 * The attack catalogue.
 *
 * Every rule here has to clear one bar: a normal user of a normal application
 * must not be able to trip it by accident. That is stricter than it sounds — it
 * rules out most of what a naive WAF ships with. `select` is a word people
 * type. `admin` is a path people have. `--` appears in slugs. None of those are
 * rules; what IS a rule is `union` NEXT TO `select`, or a tautology of the shape
 * `or 1=1`, or a request for `/etc/passwd`.
 *
 * The cost of that strictness is recall: a sufficiently clever, sufficiently
 * targeted payload will slip past. That is the right trade. A feed that cries
 * wolf is one the customer stops reading, and then it catches nothing at all.
 *
 * REGEX SAFETY. This code runs in the customer's request path. Every pattern
 * below is either a literal substring test or a regex with no nested quantifier
 * and no ambiguous adjacency, so matching is linear. Adding a pattern like
 * `(a+)+` here would hand every visitor a way to hang the site.
 */

import type { ThreatConfidence, ThreatKind, ThreatSurface } from './types.ts';

export type Rule = {
  id: string;
  kind: ThreatKind;
  confidence: ThreatConfidence;
  /** Every literal must be present in the normalised text. */
  all?: readonly string[];
  /** At least one literal must be present, in addition to `all`. */
  any?: readonly string[];
  /** Used only where a literal cannot express the shape. Must be linear-time. */
  re?: RegExp;
  /** Surfaces this rule may fire on. Defaults to path and query. */
  surfaces?: readonly ThreatSurface[];
};

const PAYLOAD: ReadonlyArray<ThreatSurface> = ['path', 'query', 'header'];
const PATH_ONLY: ReadonlyArray<ThreatSurface> = ['path'];
const UA_ONLY: ReadonlyArray<ThreatSurface> = ['user_agent'];

export const RULES: ReadonlyArray<Rule> = [
  // ── SQL injection ────────────────────────────────────────────────────────
  // The single most common attack against the databases these apps sit on, and
  // the one the marketing copy calls "database break-ins".
  { id: 'sqli.union', kind: 'sql_injection', confidence: 'certain', all: ['union', 'select'], surfaces: PAYLOAD },
  { id: 'sqli.schema', kind: 'sql_injection', confidence: 'certain', any: ['information_schema', 'pg_catalog.pg_tables', 'sysobjects'], surfaces: PAYLOAD },
  // `or 1=1`, `or 'a'='a'`, `or "x"="x"`. The backreference is what makes this a
  // tautology test rather than a match on the word "or".
  { id: 'sqli.tautology', kind: 'sql_injection', confidence: 'certain', re: /\bor\s+['"]?(\w{1,12})['"]?\s*=\s*['"]?\1['"]?/, surfaces: PAYLOAD },
  { id: 'sqli.sleep', kind: 'sql_injection', confidence: 'certain', re: /(?:^|[^a-z0-9_])(?:sleep|pg_sleep)\(\s*\d/, surfaces: PAYLOAD },
  { id: 'sqli.benchmark', kind: 'sql_injection', confidence: 'certain', re: /\bbenchmark\(\s*\d{3,}\s*,/, surfaces: PAYLOAD },
  { id: 'sqli.waitfor', kind: 'sql_injection', confidence: 'certain', all: ['waitfor', 'delay'], surfaces: PAYLOAD },
  { id: 'sqli.version', kind: 'sql_injection', confidence: 'certain', any: ['@@version', 'version()--', 'sqlite_master'], surfaces: PAYLOAD },
  { id: 'sqli.file', kind: 'sql_injection', confidence: 'certain', any: ['load_file(', 'into outfile', 'into dumpfile', 'xp_cmdshell'], surfaces: PAYLOAD },
  // A whole statement in user input. Requires the terminator or clause too, so
  // prose containing "select" and "from" cannot reach it.
  { id: 'sqli.statement', kind: 'sql_injection', confidence: 'certain', all: ['select', 'from'], any: [' where ', '--', ';', "'"], surfaces: PAYLOAD },
  { id: 'sqli.destructive', kind: 'sql_injection', confidence: 'certain', any: ['drop table', 'drop database', 'truncate table', 'delete from', 'insert into', 'update set'], surfaces: PAYLOAD },
  // `'` followed by a comment terminator is the shape of a closed-off literal.
  { id: 'sqli.comment', kind: 'sql_injection', confidence: 'likely', re: /['")]\s*(?:--|#|\/\*)/, surfaces: PAYLOAD },
  // Whitespace obfuscation: `/**/` used as a separator is never legitimate text.
  { id: 'sqli.inline-comment', kind: 'sql_injection', confidence: 'likely', all: ['/**/'], surfaces: PAYLOAD },

  // ── NoSQL injection ──────────────────────────────────────────────────────
  { id: 'nosqli.operator', kind: 'nosql_injection', confidence: 'certain', re: /\[\$(?:ne|gt|gte|lt|lte|regex|where|in|nin|exists|or|and)\]/, surfaces: PAYLOAD },
  { id: 'nosqli.json', kind: 'nosql_injection', confidence: 'certain', re: /\{\s*['"]\$(?:ne|gt|gte|lt|lte|regex|where|in|nin|exists)['"]\s*:/, surfaces: PAYLOAD },
  { id: 'nosqli.where', kind: 'nosql_injection', confidence: 'certain', all: ['$where'], surfaces: PAYLOAD },

  // ── Cross-site scripting ─────────────────────────────────────────────────
  { id: 'xss.script-tag', kind: 'xss', confidence: 'certain', any: ['<script', '</script'], surfaces: PAYLOAD },
  { id: 'xss.svg-onload', kind: 'xss', confidence: 'certain', all: ['<svg'], any: ['onload=', 'onerror='], surfaces: PAYLOAD },
  { id: 'xss.img-onerror', kind: 'xss', confidence: 'certain', all: ['<img'], any: ['onerror=', 'onload='], surfaces: PAYLOAD },
  { id: 'xss.iframe', kind: 'xss', confidence: 'certain', all: ['<iframe'], surfaces: PAYLOAD },
  { id: 'xss.handler', kind: 'xss', confidence: 'certain', re: /<[a-z][a-z0-9]{0,14}\s[^>]{0,64}?\bon(?:error|load|click|mouseover|focus|toggle)\s*=/, surfaces: PAYLOAD },
  { id: 'xss.js-uri', kind: 'xss', confidence: 'certain', any: ['javascript:alert', 'javascript:eval', 'javascript:fetch', 'javascript:document'], surfaces: PAYLOAD },
  { id: 'xss.cookie-theft', kind: 'xss', confidence: 'certain', any: ['document.cookie', 'document.domain=', 'window.location='], surfaces: PAYLOAD },
  { id: 'xss.data-uri', kind: 'xss', confidence: 'likely', all: ['data:text/html'], surfaces: PAYLOAD },

  // ── Path traversal ───────────────────────────────────────────────────────
  // One `../` shows up in legitimate relative references. Two never do in a URL
  // that reached a Next.js middleware.
  { id: 'traversal.dotdot', kind: 'path_traversal', confidence: 'certain', any: ['../../', '..\\..\\', '....//'], surfaces: PAYLOAD },
  { id: 'traversal.unix-files', kind: 'path_traversal', confidence: 'certain', any: ['/etc/passwd', '/etc/shadow', '/proc/self/environ', '/root/.ssh/'], surfaces: PAYLOAD },
  { id: 'traversal.windows-files', kind: 'path_traversal', confidence: 'certain', any: ['windows/win.ini', 'boot.ini', 'system32/drivers/etc/hosts'], surfaces: PAYLOAD },
  // A null byte in a path is a filename-truncation trick and nothing else.
  { id: 'traversal.nullbyte', kind: 'path_traversal', confidence: 'certain', all: ['\u0000'], surfaces: PAYLOAD },

  // ── Command injection ────────────────────────────────────────────────────
  { id: 'cmdi.chained', kind: 'command_injection', confidence: 'certain', re: /[;|&]\s*(?:cat|ls|id|whoami|curl|wget|nc|bash|sh|python|perl|chmod|rm)\s/, surfaces: PAYLOAD },
  { id: 'cmdi.substitution', kind: 'command_injection', confidence: 'certain', re: /\$\(\s*(?:id|whoami|curl|wget|cat|uname|sh|bash|nc|python)\b/, surfaces: PAYLOAD },
  { id: 'cmdi.backtick', kind: 'command_injection', confidence: 'certain', re: /`\s*(?:id|whoami|curl|wget|cat|uname)\b/, surfaces: PAYLOAD },
  { id: 'cmdi.shell-path', kind: 'command_injection', confidence: 'certain', any: ['/bin/sh', '/bin/bash', 'cmd.exe', 'powershell.exe'], surfaces: PAYLOAD },

  // ── Code / expression injection ──────────────────────────────────────────
  // Log4Shell and its relatives. Still probed constantly, years on.
  { id: 'codei.jndi', kind: 'code_injection', confidence: 'certain', any: ['${jndi:', '${env:', '${::-', '${lower:'], surfaces: PAYLOAD },
  { id: 'codei.deserialize', kind: 'code_injection', confidence: 'certain', any: ['ro0ab', 'java.lang.runtime', '__proto__[', 'constructor[prototype]'], surfaces: PAYLOAD },
  { id: 'codei.php', kind: 'code_injection', confidence: 'certain', any: ['<?php', 'php://input', 'php://filter', 'data://text/plain'], surfaces: PAYLOAD },

  // ── Server-side template injection ───────────────────────────────────────
  { id: 'ssti.arith-mustache', kind: 'template_injection', confidence: 'certain', re: /\{\{\s*\d{1,6}\s*[*+\-/]\s*\d{1,6}\s*\}\}/, surfaces: PAYLOAD },
  { id: 'ssti.arith-dollar', kind: 'template_injection', confidence: 'certain', re: /\$\{\s*\d{1,6}\s*[*+\-/]\s*\d{1,6}\s*\}/, surfaces: PAYLOAD },
  { id: 'ssti.class-walk', kind: 'template_injection', confidence: 'certain', any: ['__class__', '__globals__', '__subclasses__', 'self.__dict__'], surfaces: PAYLOAD },

  // ── Server-side request forgery ──────────────────────────────────────────
  // The cloud metadata endpoints are the prize; nothing legitimate asks a public
  // app to fetch them.
  { id: 'ssrf.metadata', kind: 'ssrf', confidence: 'certain', any: ['169.254.169.254', 'metadata.google.internal', 'metadata.azure.com', '100.100.100.200'], surfaces: PAYLOAD },
  { id: 'ssrf.scheme', kind: 'ssrf', confidence: 'certain', any: ['file:///', 'gopher://', 'dict://', 'ftp://127.0.0.1'], surfaces: PAYLOAD },
  { id: 'ssrf.loopback', kind: 'ssrf', confidence: 'likely', any: ['http://127.0.0.1', 'http://localhost:', 'http://0.0.0.0', 'http://[::1]'], surfaces: PAYLOAD },

  // ── Configuration and secret probing ─────────────────────────────────────
  // Path-only, and safe to be blunt about: these run against a Next.js
  // middleware, so a request for /wp-login.php is not a WordPress user taking a
  // wrong turn. It is somebody working through a list.
  { id: 'probe.dotfiles', kind: 'secret_probe', confidence: 'certain', any: ['/.env', '/.git/', '/.svn/', '/.hg/', '/.aws/', '/.ssh/', '/.npmrc', '/.dockercfg'], surfaces: PATH_ONLY },
  { id: 'probe.config', kind: 'secret_probe', confidence: 'certain', any: ['/web.config', '/appsettings.json', '/config.php', '/configuration.php', '/wp-config.php', '/credentials.json'], surfaces: PATH_ONLY },
  { id: 'probe.wordpress', kind: 'secret_probe', confidence: 'certain', any: ['/wp-admin', '/wp-login.php', '/xmlrpc.php', '/wp-content/', '/wp-includes/'], surfaces: PATH_ONLY },
  { id: 'probe.dbadmin', kind: 'secret_probe', confidence: 'certain', any: ['/phpmyadmin', '/phpmyadmin/', '/pma/', '/adminer.php', '/dbadmin/'], surfaces: PATH_ONLY },
  { id: 'probe.backup', kind: 'secret_probe', confidence: 'certain', any: ['/backup.sql', '/dump.sql', '/database.sql', '/db.sql', '/backup.zip', '/backup.tar.gz', '/.env.backup'], surfaces: PATH_ONLY },
  { id: 'probe.actuator', kind: 'secret_probe', confidence: 'certain', any: ['/actuator/env', '/actuator/heapdump', '/server-status', '/server-info', '/debug/pprof'], surfaces: PATH_ONLY },
  { id: 'probe.known-rce', kind: 'secret_probe', confidence: 'certain', any: ['/_ignition/execute-solution', '/vendor/phpunit', '/cgi-bin/', '/solr/admin', '/struts/'], surfaces: PATH_ONLY },
  { id: 'probe.cloud-keys', kind: 'secret_probe', confidence: 'certain', any: ['/.vscode/sftp.json', '/.idea/workspace.xml', '/id_rsa', '/.git-credentials'], surfaces: PATH_ONLY },

  // ── Attack tooling, which announces itself ───────────────────────────────
  // These strings appear in no browser and no legitimate crawler. Medium rather
  // than high: a scan is reconnaissance, not a breach.
  {
    id: 'scanner.tooling',
    kind: 'scanner',
    confidence: 'certain',
    any: [
      'sqlmap', 'nikto', 'nuclei', 'acunetix', 'nessus', 'openvas', 'netsparker',
      'arachni', 'w3af', 'skipfish', 'wpscan', 'havij', 'commix', 'xsstrike',
      'dirbuster', 'gobuster', 'feroxbuster', 'ffuf', 'masscan', 'zgrab',
      'nmap scripting engine', 'qualys', 'whatweb', 'jaeles',
    ],
    surfaces: UA_ONLY,
  },
];

/**
 * Characters that appear in payload rules but rarely in ordinary URLs.
 *
 * Rules whose literals all avoid these are checked on every request; the rest
 * are skipped when the text holds none of them. The split is computed from the
 * rules themselves rather than hand-maintained, so a new rule cannot be
 * silently excluded by forgetting to update a list.
 */
const TRIGGER_CHARS = "'\"<>$;|`(){}\\";

function hasTriggerChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (TRIGGER_CHARS.includes(value[i]!)) return true;
  }
  return false;
}

function ruleNeedsTrigger(rule: Rule): boolean {
  // A regex rule may match on anything, so it is never skipped.
  if (rule.re) return false;
  const literals = [...(rule.all ?? []), ...(rule.any ?? [])];
  if (literals.length === 0) return false;
  // Only skippable if EVERY literal depends on a trigger character. `any` rules
  // need all alternatives to depend on one, or a plain alternative would be lost.
  return literals.every((lit) => hasTriggerChar(lit));
}

/** Rules that can only match text containing a trigger character. */
export const TRIGGERED_RULES: ReadonlyArray<Rule> = RULES.filter(ruleNeedsTrigger);
/** Rules that must be evaluated on every request. */
export const ALWAYS_RULES: ReadonlyArray<Rule> = RULES.filter((r) => !ruleNeedsTrigger(r));

export { hasTriggerChar };
