/**
 * Joins items with `sep`, keeping the text within `max` characters. Only whole items
 * are shown; when some do not fit, `more(hiddenCount)` is appended as the last entry.
 */
export function capList(items, { max = 2000, sep = ', ', more }) {
  const full = items.join(sep);
  if (full.length <= max) return full;
  let shown = 0;
  let length = 0; // length of items[0..shown) joined with sep
  for (; shown < items.length; shown += 1) {
    const next = length + (shown ? sep.length : 0) + items[shown].length;
    const suffix = more(items.length - shown - 1);
    if (next + sep.length + suffix.length > max) break;
    length = next;
  }
  const suffix = more(items.length - shown);
  return shown ? `${items.slice(0, shown).join(sep)}${sep}${suffix}` : suffix;
}
