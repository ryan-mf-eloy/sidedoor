// Pure template-assist behavior shared by compact inputs and code editors.
// Keeping it DOM-free makes insertion, filtering and placeholder selection
// straightforward to test without coupling the runtime template syntax to UI.

function sourceOf(value) {
  return String(value == null ? '' : value);
}

function positionOf(value, position) {
  return Math.max(0, Math.min(sourceOf(value).length, Number(position) || 0));
}

function normalizeQuery(value) {
  return sourceOf(value)
    .replace(/[{}]/g, '')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Returns the unfinished {{… expression directly before the caret. A finished
// token is intentionally not treated as active while typing elsewhere.
export function activeTemplateAt(value, caret) {
  const source = sourceOf(value);
  const end = positionOf(source, caret);
  const opening = source.lastIndexOf('{{', end);
  if (opening < 0 || source.lastIndexOf('}}', end) > opening) return null;
  const expression = source.slice(opening + 2, end);
  if (/[{}\r\n]/.test(expression)) return null;
  return { start: opening, end, query: expression.trimStart() };
}

export function filterTemplateSuggestions(suggestions, query = '') {
  const needle = normalizeQuery(query);
  const list = Array.isArray(suggestions) ? suggestions : [];
  return list
    .map((suggestion, index) => {
      const token = normalizeQuery(suggestion.token);
      const example = normalizeQuery(suggestion.example);
      const label = normalizeQuery(suggestion.label);
      const description = normalizeQuery(suggestion.description);
      const group = normalizeQuery(suggestion.group);
      const haystack = `${token} ${example} ${label} ${description} ${group}`;
      if (needle && !haystack.includes(needle)) return null;
      const score = !needle ? index
        : token.startsWith(needle) ? index
          : example.startsWith(needle) ? 100 + index
            : label.startsWith(needle) ? 200 + index
              : 300 + index;
      return { suggestion, index, score };
    })
    .filter(Boolean)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.suggestion);
}

function validDynamicSuffix(value) {
  return !!value && !/[{}\s]/.test(value) && !value.startsWith('.') && !value.endsWith('.') && !value.includes('..');
}

// A catalog entry can mark the part after a prefix as dynamic. This keeps the
// picker useful for real request headers and JSON paths that cannot be known
// until a user names them, while still limiting completions to renderer-backed
// prefixes.
export function dynamicTemplateSuggestion(suggestions, query = '') {
  const expression = sourceOf(query).trim();
  const list = Array.isArray(suggestions) ? suggestions : [];
  const matching = list
    .filter((suggestion) => suggestion && suggestion.dynamicPrefix && expression.startsWith(suggestion.dynamicPrefix))
    .sort((left, right) => right.dynamicPrefix.length - left.dynamicPrefix.length);
  const source = matching[0];
  if (!source) return null;

  const suffix = expression.slice(source.dynamicPrefix.length);
  if (!validDynamicSuffix(suffix)) return null;
  return {
    token: `{{${expression}}}`,
    group: 'Complete your value',
    label: source.dynamicLabel || 'Custom value',
    description: `Use the ${source.dynamicKind || 'value'} you typed; it does not need to be listed.`,
    custom: true,
  };
}

// The dynamic completion is deliberately first: after a user starts a real
// header or field name, Enter/Tab should preserve that name instead of
// replacing it with the catalog placeholder.
export function contextualTemplateSuggestions(suggestions, query = '') {
  const listed = filterTemplateSuggestions(suggestions, query);
  const dynamic = dynamicTemplateSuggestion(suggestions, query);
  if (!dynamic || listed.some((suggestion) => suggestion.token === dynamic.token)) return listed;
  return [dynamic, ...listed];
}

function activeReplacementRange(source, selectionStart, selectionEnd) {
  const active = activeTemplateAt(source, selectionStart);
  if (!active) return { start: selectionStart, end: selectionEnd };
  const closing = source.indexOf('}}', selectionStart);
  if (closing >= 0 && !/[{}\r\n]/.test(source.slice(active.start + 2, closing))) {
    return { start: active.start, end: closing + 2 };
  }
  return { start: active.start, end: Math.max(selectionEnd, active.end) };
}

// Replaces an unfinished template (or the explicit selection) with a catalog
// token and selects its editable placeholder, such as `field` or `header-name`.
export function insertTemplateSuggestion(value, selectionStart, selectionEnd, suggestion) {
  const source = sourceOf(value);
  const start = positionOf(source, selectionStart);
  const end = Math.max(start, positionOf(source, selectionEnd));
  const replacement = activeReplacementRange(source, start, end);
  const token = sourceOf(suggestion && suggestion.token);
  const nextValue = source.slice(0, replacement.start) + token + source.slice(replacement.end);
  const placeholder = suggestion && suggestion.placeholder ? String(suggestion.placeholder) : '';
  const placeholderAt = placeholder ? token.indexOf(placeholder) : -1;
  const nextStart = placeholderAt >= 0 ? replacement.start + placeholderAt : replacement.start + token.length;
  const nextEnd = placeholderAt >= 0 ? nextStart + placeholder.length : nextStart;
  return { value: nextValue, selectionStart: nextStart, selectionEnd: nextEnd };
}
