// Autoresponder script parser: source text -> nodes. Pure, never throws.
// Syntax: plain text with {name} or {name:arg|arg} calls. Backslash escapes
// { [ | \ (anything else after a backslash is kept as written).

export const PARSE_ERROR_CODES = ['UNBALANCED_BRACE', 'EMPTY_NAME', 'BAD_NAME', 'TRAILING_BACKSLASH'];

// Private-use stand-in for an escaped `\[` inside call arguments, so later rendering
// can tell `\[$1]` (literal) from `[$1]` (a token).
export const ESCAPED_BRACKET = '';

const TOKEN_RE = /^\[(?:\$([1-9]|1\d|20)(?:(\+)|-([1-9]|1\d|20))?|(range|choice|lockedchoice)([2-4])?)\]/;

function matchToken(src, i) {
  const m = TOKEN_RE.exec(src.slice(i, i + 24));
  if (!m) return null;
  if (m[4]) return { t: 'rand', kind: m[4], n: m[5] ? Number(m[5]) : 1, pos: i, raw: m[0] };
  const from = Number(m[1]);
  let to = from;
  if (m[2]) to = 'end';
  else if (m[3]) {
    to = Number(m[3]);
    if (to < from) return null;
  }
  return { t: 'arg', from, to, pos: i, raw: m[0] };
}

const ESCAPABLE = new Set(['{', '[', '|', '\\']);
const NAME_RE = /^[A-Za-z0-9_]+$/;

export function parseScript(source) {
  const src = typeof source === 'string' ? source : '';
  const nodes = [];
  const errors = [];
  const n = src.length;
  let text = '';
  let i = 0;

  const flush = () => {
    if (text) nodes.push({ t: 'text', v: text });
    text = '';
  };

  while (i < n) {
    const ch = src[i];
    if (ch === '\\') {
      if (i + 1 >= n) {
        errors.push({ code: 'TRAILING_BACKSLASH', pos: i });
        i++;
      } else if (ESCAPABLE.has(src[i + 1])) {
        text += src[i + 1];
        i += 2;
      } else {
        text += ch;
        i++;
      }
      continue;
    }
    if (ch === '[') {
      const tok = matchToken(src, i);
      if (tok) {
        flush();
        nodes.push(tok);
        i += tok.raw.length;
        continue;
      }
    }
    if (ch !== '{') {
      text += ch;
      i++;
      continue;
    }

    // A call starts at i.
    const start = i;
    i++;
    let name = '';
    let hasColon = false;
    const args = [];
    let cur = '';
    let closed = false;
    let restart = false;
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        if (i + 1 >= n) {
          errors.push({ code: 'TRAILING_BACKSLASH', pos: i });
          i++;
        } else if (ESCAPABLE.has(src[i + 1])) {
          // The sentinel is only needed where an unescaped bracket would have formed a token.
          if (hasColon) cur += src[i + 1] === '[' && matchToken(src, i + 1) ? ESCAPED_BRACKET : src[i + 1];
          else name += src[i + 1]; // an escaped char in a name is invalid anyway
          i += 2;
        } else {
          if (hasColon) cur += c;
          else name += c;
          i++;
        }
        continue;
      }
      if (c === '{') {
        errors.push({ code: 'UNBALANCED_BRACE', pos: i });
        restart = true; // abandon the outer call, rescan from the inner brace
        break;
      }
      if (c === '}') {
        closed = true;
        i++;
        break;
      }
      if (!hasColon && c === ':') {
        hasColon = true;
        i++;
        continue;
      }
      if (hasColon) {
        if (c === '|') {
          args.push(cur.trim());
          cur = '';
        } else cur += c;
      } else name += c;
      i++;
    }
    if (restart) continue;
    if (!closed) {
      errors.push({ code: 'UNBALANCED_BRACE', pos: start });
      break;
    }
    if (hasColon) args.push(cur.trim());
    if (name === '') errors.push({ code: 'EMPTY_NAME', pos: start });
    else if (!NAME_RE.test(name)) errors.push({ code: 'BAD_NAME', pos: start, detail: name });
    else {
      flush();
      nodes.push({ t: 'call', name: name.toLowerCase(), args, pos: start });
    }
  }

  if (errors.length) {
    // `{{` reports the abandoned outer call and the unclosed inner one at the same brace: keep one.
    const seen = new Set();
    const unique = errors.filter((e) => {
      const key = `${e.code}:${e.pos}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    unique.sort((a, b) => a.pos - b.pos);
    return { ok: false, errors: unique };
  }
  flush();
  return { ok: true, nodes };
}
