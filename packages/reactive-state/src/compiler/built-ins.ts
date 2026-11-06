/**
 * The language's own globals, its namespaces, its classes and its functions — every member of which
 * is a function, a prototype or a symbol, but the numbers `member-reads.ts` names: `Math.max`,
 * `JSON.stringify`, `Symbol.iterator`, `Array.prototype`, `NaN.toFixed` — which every engine that
 * runs the application holds, the browser's and the authority's alike.
 */
export const BUILT_INS: ReadonlySet<string> = new Set([
  'AggregateError',
  'Array',
  'ArrayBuffer',
  'Atomics',
  'BigInt',
  'BigInt64Array',
  'BigUint64Array',
  'Boolean',
  'DataView',
  'Date',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'Error',
  'escape',
  'eval',
  'EvalError',
  'FinalizationRegistry',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'Function',
  'Infinity',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Intl',
  'isFinite',
  'isNaN',
  'Iterator',
  'JSON',
  'Map',
  'Math',
  'NaN',
  'Number',
  'Object',
  'parseFloat',
  'parseInt',
  'Promise',
  'Proxy',
  'RangeError',
  'ReferenceError',
  'Reflect',
  'RegExp',
  'Set',
  'SharedArrayBuffer',
  'String',
  'Symbol',
  'SyntaxError',
  'TypeError',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
  'unescape',
  'URIError',
  'WeakMap',
  'WeakRef',
  'WeakSet',
  'WebAssembly',
]);

/** The platform's compression streams, made of a format each (`COMPRESSION_FORMATS`). */
export const COMPRESSION_STREAMS: ReadonlySet<string> = new Set([
  'CompressionStream',
  'DecompressionStream',
]);

/**
 * The formats a compression stream takes on every side — the browsers', Node's, workerd's — of
 * which Node's `brotli` is none of workerd's.
 */
export const COMPRESSION_FORMATS: ReadonlySet<string> = new Set(['deflate', 'deflate-raw', 'gzip']);

/**
 * The platform's globals the browser and the authority's runtimes — Node's, workerd's — hold alike,
 * of what they are given alone: what makes and reads URLs, text, bodies and streams, a copy of a
 * value, a log. Not those of chance, of the time or of where they run (`settled.ts`).
 */
export const PLATFORM_ALIKE: ReadonlySet<string> = new Set([
  'AbortController',
  'atob',
  'Blob',
  'btoa',
  'ByteLengthQueuingStrategy',
  'CompressionStream',
  'console',
  'CountQueuingStrategy',
  'DecompressionStream',
  'DOMException',
  'Event',
  'EventTarget',
  'File',
  'FormData',
  'Headers',
  'queueMicrotask',
  'ReadableStream',
  'Request',
  'Response',
  'structuredClone',
  'TextDecoder',
  'TextDecoderStream',
  'TextEncoder',
  'TextEncoderStream',
  'TransformStream',
  'URL',
  'URLSearchParams',
  'WritableStream',
]);
