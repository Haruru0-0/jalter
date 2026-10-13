export function renderTemplate(text, vars) {
  return text.replace(/\{(user|username|server|count|boosts)\}/g, (match, key) =>
    vars[key] === undefined ? match : String(vars[key]),
  );
}
