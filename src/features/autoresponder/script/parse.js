// Autoresponder script parser: source text -> nodes. Pure, never throws.
// Syntax: plain text with {name} or {name:arg|arg} calls. Backslash escapes
// { [ | \ (anything else after a backslash is kept as written).

export const PARSE_ERROR_CODES = ['UNBALANCED_BRACE', 'EMPTY_NAME', 'BAD_NAME', 'TRAILING_BACKSLASH'];

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
          if (hasColon) cur += src[i + 1];
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
    errors.sort((a, b) => a.pos - b.pos);
    return { ok: false, errors };
  }
  flush();
  return { ok: true, nodes };
}
