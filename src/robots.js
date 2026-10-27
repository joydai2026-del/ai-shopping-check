// Minimal robots.txt parser following RFC 9309 matching rules:
// pick the group(s) naming the bot, else the "*" group; longest matching
// rule wins; on a tie, Allow wins.

export function parseRobots(text = '') {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let lastWasAgent = false;
  let ruleCount = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(val.split('/')[0].trim().toLowerCase());
      lastWasAgent = true;
      continue;
    }
    if (key === 'sitemap') {
      if (val) sitemaps.push(val);
      continue;
    }
    lastWasAgent = false;
    if ((key === 'allow' || key === 'disallow') && current && ruleCount++ < MAX_RULES) {
      current.rules.push(compileRule(key === 'allow', val));
    }
  }
  return { groups, sitemaps };
}

export function rulesFor(parsed, agent) {
  const token = agent.toLowerCase();
  let matched = parsed.groups.filter((g) => g.agents.includes(token));
  if (!matched.length) matched = parsed.groups.filter((g) => g.agents.includes('*'));
  return { rules: matched.flatMap((g) => g.rules), specific: matched.some((g) => g.agents.includes(token)) };
}

// Wildcard match without regular expressions or backtracking, so a hostile
// robots.txt cannot freeze the server. Robots patterns only have "*" (anything)
// and a trailing "$" (end). Matching each piece at its leftmost spot is enough,
// which keeps the work close to linear.
const MAX_LEN = 2000;

// Google's robots.txt spec compares paths in one encoding: non-ASCII characters
// as UTF-8 percent-escapes, escapes in upper case, and escaped unreserved
// characters (letters, digits, - . _ ~) decoded. Both rules and paths go through
// this, so "/café", "/caf%C3%A9" and "/caf%c3%a9" all match each other.
// One pass over the string, so it stays linear.
const UNRESERVED = /[A-Za-z0-9\-._~]/;
export function normalizePath(raw) {
  const s = String(raw).slice(0, MAX_LEN);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '%' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      const hex = s.slice(i + 1, i + 3).toUpperCase();
      const dec = String.fromCharCode(parseInt(hex, 16));
      // %24 and %2A stand for a literal "$" and "*" (RFC 9309 2.2.3). Decoding them
      // is safe here because rule syntax (* and a trailing $) is split off first.
      out += UNRESERVED.test(dec) || dec === '$' || dec === '*' ? dec : `%${hex}`;
      i += 2;
      continue;
    }
    const code = s.charCodeAt(i);
    if (code > 0x7e || code < 0x21) {
      // Take a whole surrogate pair for characters outside the basic plane.
      const pair = code >= 0xd800 && code <= 0xdbff && i + 1 < s.length ? s.slice(i, i + 2) : ch;
      try { out += encodeURIComponent(pair); } catch { out += '%EF%BF%BD'; }
      i += pair.length - 1;
      continue;
    }
    out += ch;
  }
  return out;
}
const MAX_RULES = 1000;
// A rule is split into its syntax BEFORE any decoding: a bare "*" is a
// wildcard and a final "$" is an end anchor. The literal pieces in between are
// then normalized, so "%2A" and "%24" in a rule only ever match a literal * or $.
function compileRule(allow, raw) {
  const text = String(raw).slice(0, MAX_LEN);
  const anchored = text.endsWith('$');
  const segs = (anchored ? text.slice(0, -1) : text).split('*').map(normalizePath);
  return { allow, path: text, len: segs.join('*').length + (anchored ? 1 : 0), segs, anchored };
}

function patternMatches(rule, s) {
  const { segs, anchored } = rule;
  if (!s.startsWith(segs[0])) return false;
  let pos = segs[0].length;
  if (segs.length === 1) return anchored ? s.length === pos : true;
  for (let k = 1; k < segs.length - 1; k++) {
    if (!segs[k]) continue;
    const idx = s.indexOf(segs[k], pos);
    if (idx < 0) return false;
    pos = idx + segs[k].length;
  }
  const last = segs[segs.length - 1];
  if (!anchored) return !last || s.indexOf(last, pos) >= 0;
  return s.length - last.length >= pos && s.endsWith(last);
}

export function isAllowed(parsed, agent, rawPath = '/') {
  const { rules } = rulesFor(parsed, agent);
  const path = normalizePath(rawPath);
  let best = null;
  for (const r of rules) {
    if (!r.path) continue; // "Disallow:" with nothing means allow everything
    if (!patternMatches(r, path)) continue;
    const len = r.len;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}
