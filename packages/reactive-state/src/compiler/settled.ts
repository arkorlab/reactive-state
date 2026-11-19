import {
  type Expression,
  type Identifier,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isMetaProperty,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  isStringLiteral,
  type Node,
  type SourceFile,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { BUILT_INS, PLATFORM_ALIKE } from './built-ins.ts';
import { globalPathOf, isErased } from './code-globals.ts';
import { fixedDateInput, fixedDateText } from './dated.ts';
import { framedRead } from './framed.ts';
import { functionRead } from './function-reads.ts';
import { handedGlobal } from './handed-globals.ts';
import { inputMetadata } from './input-metadata.ts';
import { isKept, readsKeptIterator, runsPerCall } from './kept.ts';
import { dateText, LOCAL_METHODS, localRead } from './local-reads.ts';
import { platformOtherwise } from './platform-otherwise.ts';
import { keptRootOf, keptTargetsOf, nestedKeptMethodWrite } from './settled-receivers.ts';
import { keptCallParameterWrite } from './settled-writes.ts';
import { sharedProxyOrigin } from './shared-proxies.ts';
import { timedMaking } from './timed.ts';
import { CHANGING_FUNCTIONS, methodOf, writtenArgumentBy, writtenBy } from './written.ts';

/**
 * What makes a `shared` module's code answer otherwise each time, or on each side, it runs — of
 * chance, of the time, of where it runs — its time zone, its locale — of how each side's bundle
 * writes it, of what it keeps between calls — of which no value the browser and the authority each
 * compute may be computed: what a dynamic site is computed of, a condition it stands under, a state
 * the browser starts that a site reads (`modules.ts`). What else of its engine a module's code
 * answers of — the Unicode data it ships, how it approximates `Math` — the application keeps alike,
 * as it writes it for both sides.
 */

/**
 * The globals that answer of chance, of the time, of where they run, or reach out of it: the
 * page's, Node's, a store's, the network, a timer, a weak reference, which answers as its engine
 * collects, a shared buffer, which a page holds isolated alone, `WebAssembly`, which validates and
 * compiles of the features its engine holds — and the global object by a name one side gives it
 * alone, `window`, `self`, `global`.
 */
const UNSETTLED_GLOBALS: ReadonlySet<string> = new Set([
  'caches',
  'crypto',
  'document',
  'EventSource',
  'fetch',
  'FinalizationRegistry',
  'global',
  'indexedDB',
  'Intl',
  'localStorage',
  'location',
  'navigator',
  'performance',
  'process',
  'requestAnimationFrame',
  'requestIdleCallback',
  'self',
  'sessionStorage',
  'setImmediate',
  'setInterval',
  'setTimeout',
  'SharedArrayBuffer',
  'WeakRef',
  'WebAssembly',
  'WebSocket',
  'window',
  'XMLHttpRequest',
]);

/**
 * The globals beside the language's own (`BUILT_INS`) that every side holds alike, which a test of
 * whether one is there tells nothing of where it runs — and a function's `arguments`, of no
 * declaration.
 */
const ALIKE_GLOBALS: ReadonlySet<string> = new Set(['arguments', 'globalThis', 'undefined']);

/** The names the global object goes by, whose entries a test of tells where it runs. */
const GLOBAL_HOLDERS: ReadonlySet<string> = new Set(['global', 'globalThis', 'self', 'window']);

/** The methods of an object that test whether it holds an entry of its own, by the name given. */
const OWNING: ReadonlySet<string> = new Set(['hasOwnProperty', 'propertyIsEnumerable']);

/** Static built-ins that test or read a property of their first argument by key. */
const STATIC_PROBES: ReadonlySet<string> = new Set([
  'Object.getOwnPropertyDescriptor',
  'Object.hasOwn',
  'Object.prototype.hasOwnProperty.call',
  'Object.prototype.propertyIsEnumerable.call',
  'Reflect.getOwnPropertyDescriptor',
  'Reflect.has',
]);

/** The functions of globals each engine answers of its own: `Atomics.isLockFree` of most sizes. */
const ENGINE_ANSWERS: ReadonlySet<string> = new Set(['Atomics.isLockFree']);

/** The members of `Error` one engine alone holds, V8, of the frames an error is made in. */
export const ENGINE_ERRORS: ReadonlySet<string> = new Set([
  'Error.captureStackTrace',
  'Error.prepareStackTrace',
  'Error.stackTraceLimit',
]);

/**
 * The functions of globals that answer of chance or of the time: `Math.random`, `Date.now`, `Date`
 * called through `Function`'s methods, an object's URL, of a key of chance, a wait.
 */
const UNSETTLED_FUNCTIONS: ReadonlySet<string> = new Set([
  // Which blocks the thread it runs on, and throws on a page's.
  'Atomics.wait',
  'Date.apply',
  'Date.bind',
  'Date.call',
  'Date.now',
  'Math.random',
  'URL.createObjectURL',
]);

/**
 * The members of globals the compile reads by their names alone (`handedGlobal`): those that answer
 * otherwise as they run, and those that change what they are given.
 */
const REACHED: ReadonlySet<string> = unionOf([
  CHANGING_FUNCTIONS,
  ENGINE_ANSWERS,
  ENGINE_ERRORS,
  UNSETTLED_FUNCTIONS,
]);

/** The names any of `sets` holds. */
function unionOf(sets: readonly ReadonlySet<string>[]): ReadonlySet<string> {
  const union = new Set<string>();
  for (const names of sets) {
    for (const name of names) {
      union.add(name);
    }
  }
  return union;
}

/**
 * What of `sourceFile`'s code answers otherwise each time, or on each side, it runs — a global of
 * chance, of the time, of where it runs (`UNSETTLED_GLOBALS`, `UNSETTLED_FUNCTIONS`), a date of
 * now, `new Date()`, `Date()`, the source of a function of its (`functionRead`), or what it keeps
 * between calls, a name of the module's a function writes (`keptWrite`) — said as a refusal says
 * it; none of a module of what it is given alone.
 */
export function unsettledIn(sourceFile: SourceFile): string | undefined {
  if (sharedProxyOrigin(sourceFile) !== undefined) {
    return 'exports a Proxy result that cannot be measured without invoking application traps';
  }
  let found: string | undefined;
  const visit = (node: Node): void => {
    if (found !== undefined || isErased(node)) {
      return;
    }
    found = unsettledAt(node);
    if (found === undefined) {
      node.forEachChild(visit);
    }
  };
  sourceFile.forEachChild(visit);
  return found;
}

/** What at `node` answers otherwise as it runs (`unsettledIn`); none of what does not. */
function unsettledAt(node: Node): string | undefined {
  const global = globalRead(node);
  if (global !== undefined) {
    return global;
  }
  const made = madeDate(node) ?? timedMaking(node) ?? platformOtherwise(node);
  if (made !== undefined) {
    return made;
  }
  const method = isCallExpression(node) ? methodOf(node) : undefined;
  if (method !== undefined && LOCAL_METHODS.has(method)) {
    return `calls \`${method}()\`, of the time zone or the locale where it runs`;
  }
  const local = localRead(node) ?? dateText(node) ?? functionRead(node) ?? inputMetadata(node);
  if (local !== undefined) {
    return local;
  }
  const kept = keptWrite(node) ?? keptMethodWrite(node);
  if (kept !== undefined) {
    return `keeps what a function of its writes between calls, \`${kept.text}\``;
  }
  return isIdentifier(node) && readsKeptIterator(node, writtenBy)
    ? `keeps an iterator, \`${node.text}\`, which a function of its advances between calls`
    : undefined;
}

/**
 * What of a global at `node` answers otherwise as it runs (`unsettledGlobal`), tells where it runs
 * (`probedHolder`), reads an error's frames (`framedRead`), or reaches past its name what the
 * compile reads by it (`handedGlobal`); or `import.meta`, of the bundle it runs in.
 */
function globalRead(node: Node): string | undefined {
  if (isMetaProperty(node) && node.keywordToken === SyntaxKind.ImportKeyword) {
    return 'reads `import.meta`, of the bundle it runs in';
  }
  return (
    unsettledGlobal(node) ?? probedHolder(node) ?? framedRead(node) ?? handedGlobal(node, REACHED)
  );
}

/**
 * What of a global at `node` answers otherwise as it runs: one of chance, of the time or of where
 * it runs read or called (`UNSETTLED_GLOBALS`, `UNSETTLED_FUNCTIONS`); any other but the language's
 * own and the platform's both sides hold alike (`PLATFORM_ALIKE`); or one `typeof` tests,
 * `typeof document`, `typeof process`, whether it is there telling where it runs — but the
 * language's own, `typeof Map`, which every side holds (`BUILT_INS`, `ALIKE_GLOBALS`).
 */
function unsettledGlobal(node: Node): string | undefined {
  const path = globalPathOf(node);
  const [root] = path ?? [];
  if (path === undefined || root === undefined) {
    return undefined;
  }
  const named = path.join('.');
  if (ENGINE_ERRORS.has(named)) {
    return `reads \`${named}\`, which one engine alone holds`;
  }
  if (ENGINE_ANSWERS.has(named)) {
    return `calls \`${named}()\`, which each engine answers of its own`;
  }
  if (isTypeOfExpression(outerOf(node))) {
    return isAlike(root)
      ? undefined
      : `tests whether \`${root}\` is there, which tells where it runs`;
  }
  if (UNSETTLED_GLOBALS.has(root)) {
    return `reads \`${root}\`, a global of chance, of the time or of where it runs`;
  }
  if (UNSETTLED_FUNCTIONS.has(named)) {
    return `calls \`${named}()\`, of chance or of the time`;
  }
  // `screen.width`, `devicePixelRatio`: a global of neither the language's nor the platform's both
  // sides hold alike, which the authority may not hold, or hold otherwise.
  return isAlike(root) || PLATFORM_ALIKE.has(root)
    ? undefined
    : `reads \`${root}\`, a global the browser and the authority may not each hold, or hold alike`;
}

/** Whether every side holds the global `name` alike: the language's own, `globalThis`, `undefined`. */
function isAlike(name: string): boolean {
  // A shared buffer is language-defined, but a page exposes it only when isolated.
  return name !== 'SharedArrayBuffer' && (BUILT_INS.has(name) || ALIKE_GLOBALS.has(name));
}

/** What `node` stands in, past the parentheses around it. */
function outerOf(node: Node): Node {
  let at = node.parent;
  while (isParenthesizedExpression(at)) {
    at = at.parent;
  }
  return at;
}

/**
 * What of `node` tests what the global object holds, which tells where it runs — `'process' in
 * globalThis`, `globalThis.hasOwnProperty('document')` — but of a name of the language's own,
 * written there (`isAlike`).
 */
function probedHolder(node: Node): string | undefined {
  const tested = testedHolder(node);
  const held = tested === undefined ? undefined : globalPathOf(unwrapped(tested.holder));
  if (held?.length !== 1 || !GLOBAL_HOLDERS.has(held[0] ?? '')) {
    return undefined;
  }
  const key = tested?.key === undefined ? undefined : unwrapped(tested.key);
  const name =
    key !== undefined && (isStringLiteral(key) || isNoSubstitutionTemplateLiteral(key))
      ? key.text
      : undefined;
  if (name !== undefined && isAlike(name)) {
    return undefined;
  }
  const what = name === undefined ? 'a name it computes' : `\`${name}\``;
  return `tests whether the global object holds ${what}, which tells where it runs`;
}

/** Extracts the target holder and key expression from an ownership or presence probe. */
function testedHolder(
  node: Node,
): { readonly holder: Expression; readonly key: Expression | undefined } | undefined {
  if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.InKeyword) {
    return { holder: node.right, key: node.left };
  }
  if (!isCallExpression(node)) {
    return undefined;
  }
  const callee = unwrapped(node.expression);
  const path = globalPathOf(callee)?.join('.');
  if (path !== undefined && STATIC_PROBES.has(path)) {
    const [first, second] = node.arguments;
    if (first === undefined || isSpreadElement(first)) {
      return undefined;
    }
    return {
      holder: first,
      key: second === undefined || isSpreadElement(second) ? undefined : second,
    };
  }
  const method = methodOf(node);
  if (
    method !== undefined &&
    OWNING.has(method) &&
    (isPropertyAccessExpression(callee) || isElementAccessExpression(callee))
  ) {
    const [first] = node.arguments;
    return {
      holder: callee.expression,
      key: first === undefined || isSpreadElement(first) ? undefined : first,
    };
  }
  return undefined;
}

/**
 * What of `node`, a date the code makes, answers otherwise as it runs: of now, `Date()`, `new Date()`;
 * of a time read in the time zone where it runs, `new Date(2020, 0, 1)`; of either, as a spread
 * may hand none or many, `new Date(...parts)` — of an array written there too; none of another.
 * A render's reads are told by it too (`untracked-reads.ts`).
 */
export function madeDate(node: Node): string | undefined {
  if (!(isCallExpression(node) || isNewExpression(node))) {
    return undefined;
  }
  const path = globalPathOf(unwrapped(node.expression))?.join('.');
  const given = node.arguments ?? [];
  const first = given[0];
  if (path === 'Date.parse' && isCallExpression(node)) {
    return first !== undefined && fixedDateText(first)
      ? undefined
      : 'parses text that may use the time zone where it runs';
  }
  if (path !== 'Date') {
    return undefined;
  }
  if (isCallExpression(node)) {
    return 'calls `Date()`, of the time';
  }
  if (given.some((each) => isSpreadElement(each))) {
    return 'makes `new Date(...parts)`, which may be of the time, or of the time zone where it runs';
  }
  if (given.length === 0) {
    return 'makes `new Date()`, of the time';
  }
  if (given.length > 1) {
    return 'makes `new Date(year, month, …)`, of the time zone where it runs';
  }
  return first === undefined || fixedDateInput(first)
    ? undefined
    : 'makes a one-argument `Date` whose text may use the time zone where it runs';
}

/** Whether `node` is what `typeof` tests. */
function isTypeOfExpression(node: Node | undefined): boolean {
  return node?.kind === SyntaxKind.TypeOfExpression;
}

/**
 * The name `node` writes, where it is a write a function makes each time it is called — an
 * assignment, `++`, `delete`, a method or a global's function that changes what it is given, or
 * locks it — of a name the module holds once, as it loads (`isKept`): its own, an import's, a
 * global's, what a call it keeps declared; none of another.
 */
export function keptWrite(node: Node): Identifier | undefined {
  if (!runsPerCall(node)) {
    return undefined;
  }
  const written = writtenBy(node);
  const argument = writtenArgumentBy(node);
  for (const changed of [written, ...argument]) {
    if (changed === undefined) {
      continue;
    }
    for (const target of keptTargetsOf(changed)) {
      const root = keptRootOf(target);
      if (root !== undefined && isKept(root, writtenBy)) {
        return root;
      }
    }
  }
  return keptCallParameterWrite(node);
}

/**
 * The name the module holds once a call of a method of writes through `this` (`writesThis`) each
 * time a function of its calls it — `counter.bump()` or `store.counter.bump()` — none of another.
 */
export function keptMethodWrite(node: Node): Identifier | undefined {
  return nestedKeptMethodWrite(node);
}
