// Vitest setup — runs before each test file.
// jsdom doesn't ship with structuredClone in some versions; provide it.
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = (v: unknown) => JSON.parse(JSON.stringify(v))
}
