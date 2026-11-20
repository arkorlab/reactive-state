/** The native functions and constructors of the globals that leave a Date a tag hands them alone. */

/**
 * The native functions of the globals that leave a Date alone, as a number (`Number`, `isNaN`,
 * `Math`), as itself (`Object.is`, `structuredClone`, `Object.freeze`), or as the ISO text of
 * `JSON.stringify`; any other, handed a Date, is taken to write it as text or as a key.
 */
const SAFE_GLOBAL_CALLS: ReadonlySet<string> = new Set([
  'Array',
  'Array.from',
  'Array.isArray',
  'Array.of',
  'BigInt',
  'Boolean',
  'clearInterval',
  'clearTimeout',
  'Date',
  'Date.UTC',
  'isFinite',
  'isNaN',
  'JSON.stringify',
  'Number',
  'Number.isFinite',
  'Number.isNaN',
  'Object.freeze',
  'Object.getPrototypeOf',
  'Object.is',
  'Object.isExtensible',
  'Object.isFrozen',
  'Object.isSealed',
  'Object.preventExtensions',
  'Object.prototype.toString',
  'Object.seal',
  'queueMicrotask',
  'setInterval',
  'setTimeout',
  'String.fromCharCode',
  'String.fromCodePoint',
  'structuredClone',
]);
/** The globals whose every function leaves a Date alone: the arithmetic, the console, promises. */
const SAFE_GLOBAL_PREFIXES: readonly string[] = [
  'Math.',
  'Date.prototype.',
  'console.',
  'Promise.',
];
/** The native constructors that keep a Date as it is handed, by identity or as a number. */
const SAFE_GLOBAL_CONSTRUCTORS: ReadonlySet<string> = new Set([
  'Array',
  'Boolean',
  'Date',
  'Map',
  'Number',
  'Object',
  'Promise',
  'Set',
  'WeakMap',
  'WeakRef',
  'WeakSet',
]);

/** Whether the native function at the global path `path` leaves a Date it is handed alone. */
export function isSafeGlobalCall(path: string): boolean {
  return (
    SAFE_GLOBAL_CALLS.has(path) || SAFE_GLOBAL_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

/** Whether the native constructor at the global path `path` keeps a Date it is handed as it is. */
export function isSafeGlobalConstructor(path: string): boolean {
  return SAFE_GLOBAL_CONSTRUCTORS.has(path);
}
