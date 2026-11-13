// Shared formatting, highlighting and lightweight syntax validation for code
// surfaces. It intentionally has no DOM dependency so read-only previews and
// editable fields use the same safe representation.

const COLORS = {
  key: '#6a9fd4',
  string: '#8fb98a',
  boolean: '#b28de0',
  null: '#e5675c',
  number: '#d69a3c',
  punctuation: '#8a837a',
  tag: '#78a8df',
  attribute: '#d69a3c',
  comment: '#6a655c',
  keyword: '#b28de0',
  variable: '#e8b88a',
  operator: '#8a837a',
  text: '#c2bbb0',
  template: '#e8b88a',
};

const LANGUAGE_LABELS = {
  json: 'JSON',
  xml: 'XML',
  html: 'HTML',
  graphql: 'GraphQL',
  http: 'HTTP',
  shell: 'Shell',
  text: 'Text',
};

export function escCode(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function lineColumnAt(source, position) {
  const prior = source.slice(0, Math.max(0, position));
  const lines = prior.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function validation(valid, message = '', position = 0, source = '') {
  const location = lineColumnAt(source, position);
  return { valid, message, position, line: location.line, column: location.column };
}

export function detectCodeLanguage(value, requested = 'auto') {
  if (requested && requested !== 'auto') return requested;
  if (typeof value !== 'string') return 'json';
  const text = value.trim();
  if (!text) return 'text';
  if (/^(?:\{|\[|"|-?\d|true\b|false\b|null\b)/.test(text)) return 'json';
  if (/^<!doctype\s+html\b|^<html\b/i.test(text)) return 'html';
  if (/^<\?xml\b|^<\/?[A-Za-z_]/.test(text)) return 'xml';
  if (/^(?:query|mutation|subscription|fragment|type|interface|input|enum|scalar|schema|directive|extend)\b/.test(text)) return 'graphql';
  if (/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\s+\S+/m.test(text) || /^[A-Za-z-]+:\s*.+$/m.test(text)) return 'http';
  if (/^\s*(?:curl\b|npm\b|node\b|pnpm\b|yarn\b|export\s+)/.test(text)) return 'shell';
  return 'text';
}

function jsonValidation(source) {
  const text = String(source == null ? '' : source);
  if (!text.trim()) return validation(true, '', 0, text);
  try {
    JSON.parse(text);
    return validation(true, '', 0, text);
  } catch (error) {
    const match = /position\s+(\d+)/i.exec(error && error.message);
    const position = match ? Number(match[1]) : text.length;
    return validation(false, error && error.message ? error.message : 'Invalid JSON', position, text);
  }
}

function xmlFallbackValidation(source) {
  const text = String(source == null ? '' : source);
  const stack = [];
  const tag = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?([A-Za-z_][\w:.-]*)(?:\s[^<>]*?)?\s*\/?\s*>/g;
  let match;
  while ((match = tag.exec(text))) {
    const raw = match[0];
    if (/^<!--|^<!\[CDATA|^<\?/.test(raw)) continue;
    const closing = /^<\//.test(raw);
    const selfClosing = /\/\s*>$/.test(raw);
    const name = match[1];
    if (closing) {
      const open = stack.pop();
      if (!open || open.name !== name) return validation(false, `Expected </${open ? open.name : name}>`, match.index, text);
    } else if (!selfClosing) {
      stack.push({ name, position: match.index });
    }
  }
  if (stack.length) {
    const open = stack[stack.length - 1];
    return validation(false, `Missing closing tag for <${open.name}>`, open.position, text);
  }
  return validation(true, '', 0, text);
}

function xmlValidation(source) {
  const text = String(source == null ? '' : source);
  if (!text.trim()) return validation(true, '', 0, text);
  if (typeof DOMParser !== 'undefined') {
    const parsed = new DOMParser().parseFromString(text, 'application/xml');
    const parserError = parsed.querySelector && parsed.querySelector('parsererror');
    if (parserError) return validation(false, parserError.textContent.trim() || 'Invalid XML', 0, text);
  }
  return xmlFallbackValidation(text);
}

function graphqlValidation(source) {
  const text = String(source == null ? '' : source);
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const stack = [];
  let quote = null;
  let escaped = false;
  let inComment = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inComment) {
      if (char === '\n') inComment = false;
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '#') { inComment = true; continue; }
    if (char === '"') { quote = char; continue; }
    if (pairs[char]) { stack.push({ char, position: index }); continue; }
    if (char === '}' || char === ')' || char === ']') {
      const open = stack.pop();
      if (!open || pairs[open.char] !== char) return validation(false, `Unexpected ${char}`, index, text);
    }
  }
  if (quote) return validation(false, 'Unterminated GraphQL string', text.length, text);
  if (stack.length) {
    const open = stack[stack.length - 1];
    return validation(false, `Missing ${pairs[open.char]}`, open.position, text);
  }
  return validation(true, '', 0, text);
}

export function validateCode(value, requested = 'auto') {
  const language = detectCodeLanguage(value, requested);
  if (language === 'json') return { language, ...jsonValidation(value) };
  if (language === 'xml' || language === 'html') return { language, ...xmlValidation(value) };
  if (language === 'graphql') return { language, ...graphqlValidation(value) };
  return { language, ...validation(true, '', 0, String(value == null ? '' : value)) };
}

function formatXml(source) {
  const tokens = String(source).trim().replace(/>\s*</g, '><').match(/<[^>]+>|[^<]+/g) || [];
  let level = 0;
  const rows = [];
  for (const rawToken of tokens) {
    const token = rawToken.trim();
    if (!token) continue;
    const closing = /^<\//.test(token);
    const special = /^<\?|^<!/.test(token);
    const selfClosing = /\/>$/.test(token);
    if (closing) level = Math.max(0, level - 1);
    rows.push(`${'  '.repeat(level)}${token}`);
    if (!closing && !special && /^</.test(token) && !selfClosing) level++;
  }
  return rows.join('\n');
}

function tokenizeGraphql(source) {
  const tokens = [];
  const re = /#[^\n]*|"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|\$[A-Za-z_][\w]*|[A-Za-z_][\w]*|-?\d+(?:\.\d+)?|[{}()[\]!:$=@|,]/g;
  let match;
  while ((match = re.exec(source))) tokens.push(match[0]);
  return tokens;
}

function formatGraphql(source) {
  const tokens = tokenizeGraphql(String(source));
  if (!tokens.length) return String(source).trim();
  let indent = 0;
  let parenDepth = 0;
  let line = '';
  const lines = [];
  const flush = () => {
    if (line.trim()) lines.push(`${'  '.repeat(indent)}${line.trim()}`);
    line = '';
  };
  const append = (token, padBefore = false) => { line += `${padBefore && line && !/\s$/.test(line) ? ' ' : ''}${token}`; };
  let previous = '';
  for (const token of tokens) {
    if (token.startsWith('#')) { flush(); lines.push(`${'  '.repeat(indent)}${token}`); previous = token; continue; }
    if (token === '{') { append('{', true); flush(); indent++; previous = token; continue; }
    if (token === '}') { flush(); indent = Math.max(0, indent - 1); line = '}'; flush(); previous = token; continue; }
    if (token === '(' || token === '[') { append(token, false); parenDepth++; previous = token; continue; }
    if (token === ')' || token === ']' || token === '!' || token === ',') { append(token, false); if (token === ')' || token === ']') parenDepth = Math.max(0, parenDepth - 1); previous = token; continue; }
    if (token === ':') { append(':', false); line += ' '; previous = token; continue; }
    if (token === '@' || token === '=' || token === '|') { append(token, true); line += token === '=' ? ' ' : ''; previous = token; continue; }
    if (indent > 0 && parenDepth === 0 && line.trim() && previous !== ':' && previous !== '@' && previous !== '=') flush();
    const needsSpace = line && !/[\s([{:$@=|]$/.test(line) && ![')', ']', '!', ','].includes(previous);
    append(token, needsSpace);
    previous = token;
  }
  flush();
  return lines.join('\n');
}

function formatHttp(source) {
  const parts = String(source).trim().split(/\r?\n\r?\n/);
  const head = (parts.shift() || '').split(/\r?\n/).map((line, index) => index === 0 ? line.trim().replace(/\s+/g, ' ') : line.replace(/\s*:\s*/, ': ').trim());
  const body = parts.join('\n\n');
  const formattedBody = body && detectCodeLanguage(body, 'auto') === 'json' && jsonValidation(body).valid
    ? JSON.stringify(JSON.parse(body), null, 2)
    : body;
  return formattedBody ? `${head.join('\n')}\n\n${formattedBody}` : head.join('\n');
}

export function formatCode(value, requested = 'auto') {
  const source = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const checked = validateCode(source, requested);
  let formatted = source;
  if (checked.valid && source.trim()) {
    if (checked.language === 'json') formatted = JSON.stringify(JSON.parse(source), null, 2);
    else if (checked.language === 'xml' || checked.language === 'html') formatted = formatXml(source);
    else if (checked.language === 'graphql') formatted = formatGraphql(source);
    else if (checked.language === 'http') formatted = formatHttp(source);
  }
  return { ...checked, source, formatted, label: LANGUAGE_LABELS[checked.language] || 'Text' };
}

function span(color, text) { return `<span style="color:${color}">${text}</span>`; }

function highlightJson(source) {
  return escCode(source).replace(/("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g, (match) => {
    if (match.startsWith('"')) {
      if (/:\s*$/.test(match)) return `${span(COLORS.key, match.replace(/:\s*$/, ''))}${span(COLORS.punctuation, ':')}`;
      return span(COLORS.string, match);
    }
    if (match === 'true' || match === 'false') return span(COLORS.boolean, match);
    if (match === 'null') return span(COLORS.null, match);
    return span(COLORS.number, match);
  }).replace(/[{}\[\],]/g, (match) => span(COLORS.punctuation, match));
}

function highlightXmlAttributes(source) {
  return escCode(source).replace(/([A-Za-z_:][\w:.-]*)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/g, (_match, name, equals, value) => `${span(COLORS.attribute, name)}${span(COLORS.punctuation, equals)}${span(COLORS.string, value)}`);
}

function highlightXml(source) {
  const token = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z_][\w:.-]*(?:\s[^<>]*?)?\s*\/?\s*>/g;
  let result = '';
  let cursor = 0;
  let match;
  while ((match = token.exec(source))) {
    result += escCode(source.slice(cursor, match.index));
    const raw = match[0];
    if (/^<!--|^<!\[CDATA|^<\?/.test(raw)) result += span(COLORS.comment, escCode(raw));
    else {
      const parts = /^(<\/?)([A-Za-z_][\w:.-]*)([\s\S]*?)(\/?>)$/.exec(raw);
      result += `${span(COLORS.punctuation, escCode(parts[1]))}${span(COLORS.tag, escCode(parts[2]))}${highlightXmlAttributes(parts[3])}${span(COLORS.punctuation, escCode(parts[4]))}`;
    }
    cursor = match.index + raw.length;
  }
  return result + escCode(source.slice(cursor));
}

function highlightGraphql(source) {
  const token = /#[^\n]*|"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|\$[A-Za-z_][\w]*|\b(?:query|mutation|subscription|fragment|on|type|interface|input|enum|scalar|schema|directive|extend|implements|repeatable)\b|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?|[{}()[\]!:$=@|]/g;
  return escCode(source).replace(token, (match) => {
    if (match.startsWith('#')) return span(COLORS.comment, match);
    if (match.startsWith('"')) return span(COLORS.string, match);
    if (match.startsWith('$')) return span(COLORS.variable, match);
    if (/^(?:true|false)$/.test(match)) return span(COLORS.boolean, match);
    if (match === 'null') return span(COLORS.null, match);
    if (/^-?\d/.test(match)) return span(COLORS.number, match);
    if (/^[{}()[\]!:$=@|]$/.test(match)) return span(COLORS.punctuation, match);
    return span(COLORS.keyword, match);
  });
}

function highlightHttp(source) {
  return escCode(source).split('\n').map((line, index) => {
    if (index === 0) return line.replace(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)(\s+)(\S+)(.*)$/, (_m, method, space, url, rest) => `${span(COLORS.keyword, method)}${space}${span(COLORS.string, url)}${span(COLORS.text, rest)}`);
    return line.replace(/^([A-Za-z-]+)(:\s*)(.*)$/, (_m, key, colon, value) => `${span(COLORS.key, key)}${span(COLORS.punctuation, colon)}${span(COLORS.string, value)}`);
  }).join('\n');
}

function highlightShell(source) {
  return escCode(source).replace(/(^|\n)(\s*)(curl|npm|node|pnpm|yarn|export)\b|(--?[\w-]+)|("(?:\\.|[^"\\])*")|('(?:\\.|[^'\\])*')/g, (_match, lineStart, space, command, flag, doubleQuote, singleQuote) => {
    if (command) return `${lineStart || ''}${space || ''}${span(COLORS.keyword, command)}`;
    if (flag) return span(COLORS.variable, flag);
    return span(COLORS.string, doubleQuote || singleQuote || '');
  });
}

function highlightText(source) {
  return escCode(source)
    .replace(/(https?:\/\/[^\s<]+)/g, (_match, url) => span(COLORS.tag, url));
}

// Template braces are punctuation in several language highlighters. Protect
// complete tokens and the currently typed prefix before syntax highlighting,
// then restore a nested span so inline completion remains legible inside JSON
// strings, XML attributes and headers.
function protectTemplates(source) {
  const tokens = [];
  const protectedSource = String(source).replace(/\{\{\s*[^{}\r\n]*?\s*\}\}|\{\{\s*[A-Za-z_$][^\s{}"'`]*/g, (token) => {
    const marker = `\uE000${tokens.length}\uE001`;
    tokens.push({ marker, token, complete: token.endsWith('}}') });
    return marker;
  });
  return { source: protectedSource, tokens };
}

function restoreTemplates(markup, tokens) {
  return tokens.reduce((result, { marker, token, complete }) => result.split(marker).join(
    `<span style="color:${COLORS.template};font-weight:600;${complete ? '' : 'text-decoration:underline wavy rgba(232,184,138,.72);text-underline-offset:3px;'}">${escCode(token)}</span>`), markup);
}

export function highlightCode(value, requested = 'auto', opts = {}) {
  const presentation = opts.format === false
    ? { language: detectCodeLanguage(value, requested), formatted: String(value == null ? '' : value) }
    : formatCode(value, requested);
  const templates = protectTemplates(presentation.formatted);
  const source = templates.source;
  let highlighted;
  if (presentation.language === 'json') highlighted = highlightJson(source);
  else if (presentation.language === 'xml' || presentation.language === 'html') highlighted = highlightXml(source);
  else if (presentation.language === 'graphql') highlighted = highlightGraphql(source);
  else if (presentation.language === 'http') highlighted = highlightHttp(source);
  else if (presentation.language === 'shell') highlighted = highlightShell(source);
  else highlighted = highlightText(source);
  return restoreTemplates(highlighted, templates.tokens);
}

export function codeStatus(value, requested = 'auto') {
  const presentation = formatCode(value, requested);
  if (!presentation.source.trim()) return { ...presentation, text: `${presentation.label} ready` };
  if (!presentation.valid) return { ...presentation, text: `Line ${presentation.line}, col ${presentation.column} · ${presentation.message}` };
  if (presentation.language === 'graphql') return { ...presentation, text: 'GraphQL structure balanced — validating SDL' };
  if (presentation.language === 'xml') return { ...presentation, text: 'Valid XML' };
  if (presentation.language === 'html') return { ...presentation, text: 'Valid HTML' };
  if (presentation.language === 'json') return { ...presentation, text: 'Valid JSON' };
  return { ...presentation, text: `${presentation.label} formatted` };
}
