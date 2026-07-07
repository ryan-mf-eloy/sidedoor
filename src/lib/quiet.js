// Suppress the one noisy "SQLite is an experimental feature" ExperimentalWarning
// emitted by node:sqlite, while leaving every other warning intact.
// Import this BEFORE anything that imports node:sqlite.
const original = process.emitWarning.bind(process);
process.emitWarning = (warning, ...args) => {
  try {
    const type = typeof args[0] === 'object' && args[0] ? args[0].type : args[0];
    const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
    if (type === 'ExperimentalWarning' && /SQLite/i.test(text)) return;
  } catch {
    /* fall through to original */
  }
  return original(warning, ...args);
};
