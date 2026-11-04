import {
  type Expression,
  type Identifier,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isElementAccessExpression,
  isExportDeclaration,
  isExpressionWithTypeArguments,
  isIdentifier,
  isImportDeclaration,
  isInterfaceDeclaration,
  isModuleDeclaration,
  isNamespaceImport,
  isNewExpression,
  isObjectBindingPattern,
  isObjectLiteralExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isTypeAliasDeclaration,
  isTypeNode,
  isTypeParameterDeclaration,
  isVariableDeclaration,
  isVoidExpression,
  type Node,
  NodeFlags,
  type SourceFile,
  type Statement,
  SyntaxKind,
} from 'typescript/ast';

import { aliasedFrameRead } from './aliased-frame-reads.ts';
import { literalName, unwrapped } from './bounded.ts';
import { BUILT_INS, PLATFORM_ALIKE } from './built-ins.ts';
import { patternKey, useOf } from './code-globals.ts';
import { fileReadsClock, fileReferenceReadsClock } from './file-timestamps.ts';
import { framedInputName } from './framed-bindings.ts';
import { framedNativeConstructor } from './framed-sources.ts';
import { framedPropertyNames } from './framed-symbol-keys.ts';
import { framedRead, initializerOf, takenApartOf } from './framed.ts';
import { inheritedDateFormat } from './inherited-date-formats.ts';
import { LOCAL_TIME, localDateInput } from './local-date-inputs.ts';
import { multipartMaking } from './multipart.ts';
import { prefixDeclarations } from './prefix.ts';
import { borrowedDateFormatClock } from './render-borrowed-date-clock.ts';
import { aliasedDateFormatClock } from './render-date-arguments.ts';
import { renderDateConversion } from './render-date-conversions.ts';
import { renderDateParser } from './render-date-parsers.ts';
import { storedIntlReceiver } from './render-intl-projections.ts';
import { reflectedRead } from './render-intl-reflections.ts';
import { renderLocalInput } from './render-local-inputs.ts';
import { renderPlatformGlobal } from './render-platform-globals.ts';
import { freeReads, isTypeOnly } from './scope.ts';
import { ENGINE_ERRORS, madeDate } from './settled.ts';
import { eventReadsClock } from './timed.ts';

/**
 * What of a module's code reads an input nothing tracks, read off its syntax (`reach.ts`): a global
 * of the clock, of randomness, of the network or of where the code runs, read where no scope around
 * the read declares its name; a date made or parsed in the time zone where it runs; the time a
 * date's format formats where it is given no date; the clock a File takes where its timestamp is
 * not shown defined; an event's creation time; a FormData multipart boundary; and the frames an
 * error is made in.
 */

/** The globals whose every read is an input nothing tracks. */
const UNTRACKED: ReadonlySet<string> = new Set([
  'caches',
  'crypto',
  'document',
  'eval',
  'EventSource',
  'fetch',
  // A weak reference, which answers as its engine collects.
  'FinalizationRegistry',
  'Function',
  'global',
  'globalThis',
  'indexedDB',
  'localStorage',
  'location',
  'navigator',
  'performance',
  'requestAnimationFrame',
  'requestIdleCallback',
  // A CommonJS load, which the compile does not follow: of a module it cannot classify.
  'require',
  'self',
  'sessionStorage',
  'setImmediate',
  'setInterval',
  'setTimeout',
  'WeakRef',
  'WebAssembly',
  'WebSocket',
  'window',
  'XMLHttpRequest',
]);

/** Native body constructors retain their distinct body argument positions. */
const MULTIPART_REQUESTS: ReadonlySet<string> = new Set(['Request']);
const MULTIPART_RESPONSES: ReadonlySet<string> = new Set(['Response']);

/** Whether `node` names a type, which is erased from what runs and reads nothing. */
function isTypePosition(node: Node): boolean {
  return (
    (isTypeNode(node) && !isExpressionWithTypeArguments(node)) ||
    isTypeAliasDeclaration(node) ||
    isInterfaceDeclaration(node) ||
    isTypeParameterDeclaration(node)
  );
}

/**
 * Whether `Date`, where `node` reads it, reads the clock: not `new Date(value)`, nor `Date.UTC` —
 * but `new Date(...values)`, of values it spreads, which may be none, however it spreads them.
 */
function readsClock(node: Node): boolean {
  const { parent } = node;
  if (isNewExpression(parent) && parent.expression === node) {
    const given = parent.arguments ?? [];
    return given.length === 0 || given.some((each) => isSpreadElement(each));
  }
  if (isPropertyAccessExpression(parent) && parent.expression === node) {
    return parent.name.text !== 'UTC' && parent.name.text !== 'parse';
  }
  return true;
}

/**
 * Whether `Date`, where `node` reads it, makes or parses a date in the time zone where it runs, as a
 * `shared` module's is told (`madeDate`, `settled.ts`): `new Date(2020, 0, 1)`, a one-argument
 * `Date` of text that may name a local time, `new Date('2020-01-01T00:00')`, or `Date.parse` of it —
 * but not of a number, a date, `Date.UTC(…)`, ISO date-only text or text with an offset.
 */
function readsZone(node: Node): boolean {
  const { parent } = node;
  if (isNewExpression(parent) && parent.expression === node) return madeDate(parent) !== undefined;
  const call = parent.parent;
  return (
    isPropertyAccessExpression(parent) &&
    parent.expression === node &&
    isCallExpression(call) &&
    call.expression === parent &&
    madeDate(call) !== undefined
  );
}

/** What `Date`, where `node` reads it, reads: the clock (`readsClock`), or the time zone (`readsZone`). */
function dateRead(node: Node): string | undefined {
  if (readsClock(node)) return 'Date';
  return readsZone(node) ? LOCAL_TIME : undefined;
}

/**
 * Whether a global, where `node` reads it, reads its member `member` — `Math.random` of `Math`, of
 * randomness; `Temporal.Now` of `Temporal`, of the clock — or is handed on whole.
 */
function readsMember(node: Node, member: string): boolean {
  const { parent } = node;
  return (
    !(isPropertyAccessExpression(parent) && parent.expression === node) ||
    parent.name.text === member
  );
}

/** Whether `process`, where `node` reads it, reads more than `process.env`. */
function readsProcess(node: Node): boolean {
  const { parent } = node;
  return !(
    isPropertyAccessExpression(parent) &&
    parent.expression === node &&
    parent.name.text === 'env'
  );
}

/** The untracked global `identifier` reads, where it reads one. */
function untrackedRead(identifier: Identifier): string | undefined {
  const { text } = identifier;
  if (UNTRACKED.has(text)) {
    return text;
  }
  switch (text) {
    case 'Atomics': {
      return atomicsInput(identifier);
    }
    case 'Date': {
      return dateRead(identifier);
    }
    case 'File': {
      return fileReferenceReadsClock(identifier) ? 'File.lastModified' : undefined;
    }
    case 'Math': {
      return readsMember(identifier, 'random') ? 'Math.random' : undefined;
    }
    case 'Temporal': {
      return readsMember(identifier, 'Now') ? 'Temporal.Now' : undefined;
    }
    case 'process': {
      return readsProcess(identifier) ? 'process' : undefined;
    }
    default: {
      return knownRenderGlobal(text) ? undefined : text;
    }
  }
}

/** Only language and common-platform globals can answer alike without a specific input rule. */
function knownRenderGlobal(name: string): boolean {
  if (name === 'SharedArrayBuffer') return false;
  return (
    name === 'arguments' || name === 'undefined' || BUILT_INS.has(name) || PLATFORM_ALIKE.has(name)
  );
}

/** Native waits block the authority, and lock-free answers depend on the engine. */
const ATOMICS_INPUTS: ReadonlySet<string> = new Set(['isLockFree', 'wait']);

/** A known ordinary member stays data; an opaque member or whole namespace may select an input. */
function atomicsInput(node: Identifier): string | undefined {
  const { parent } = node;
  const selected =
    (isPropertyAccessExpression(parent) || isElementAccessExpression(parent)) &&
    parent.expression === node;
  if (!selected) return 'Atomics';
  const name = isPropertyAccessExpression(parent) ? parent.name.text : literalName(parent);
  if (name === undefined) return 'Atomics';
  return ATOMICS_INPUTS.has(name) ? `Atomics.${name}` : undefined;
}

/** The objects whose members are the globals: `globalThis`, `self`, `window`, Node's `global`. */
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(['global', 'globalThis', 'self', 'window']);

/** Each file's reads of globals, as `globalReads` resolves them once. */
const GLOBAL_READS = new WeakMap<SourceFile, ReadonlySet<Identifier>>();

/** Whether `node` is declared by `declare`, which binds nothing that runs. */
function isAmbient(node: Node): boolean {
  // eslint-disable-next-line no-bitwise -- TypeScript says `declare` in these flags alone.
  return (node.flags & NodeFlags.Ambient) !== 0;
}

/**
 * The names `statement`, an import, binds to values: none of a type alone, `import type`,
 * `{ type T }`.
 */
function importedLocals(statement: Statement): readonly string[] {
  const clause = isImportDeclaration(statement) ? statement.importClause : undefined;
  if (clause === undefined || clause.phaseModifier === SyntaxKind.TypeKeyword) {
    return [];
  }
  const named = clause.namedBindings;
  const own = clause.name === undefined ? [] : [clause.name.text];
  if (named === undefined) {
    return own;
  }
  return isNamespaceImport(named)
    ? [...own, named.name.text]
    : [...own, ...named.elements.filter((each) => !each.isTypeOnly).map((each) => each.name.text)];
}

/**
 * The names `sourceFile`'s top level binds as it runs: its imports of values, and what it declares,
 * a `var` anywhere outside its functions among them; none of a type, of an overload's signature,
 * nor of what `declare` declares, which bind nothing that runs.
 */
function moduleNames(sourceFile: SourceFile): ReadonlySet<string> {
  const runs = sourceFile.statements.filter((statement) => !isAmbient(statement));
  const names = new Set(runs.flatMap((statement) => importedLocals(statement)));
  for (const identifier of prefixDeclarations(runs)) {
    if (!isTypeOnly(identifier.parent)) {
      names.add(identifier.text);
    }
  }
  return names;
}

/**
 * The reads in `sourceFile` of a global: of a name no scope around the read declares — no function,
 * block, loop or `catch`, as `scope.ts` resolves names (`freeReads`), nor the module's top level
 * (`moduleNames`). A name the file declares elsewhere — a callback's parameter, a type's, a local
 * of another function — is none of the read's.
 */
function globalReads(sourceFile: SourceFile): ReadonlySet<Identifier> {
  let reads = GLOBAL_READS.get(sourceFile);
  if (reads === undefined) {
    const own = moduleNames(sourceFile);
    reads = new Set(freeReads(sourceFile).filter((read) => !own.has(read.text)));
    GLOBAL_READS.set(sourceFile, reads);
  }
  return reads;
}

/**
 * The names a read of a global goes by, the global first — `Error`, `captureStackTrace` of
 * `Error.captureStackTrace`, of `globalThis.Error['captureStackTrace']` too, the global object read
 * past — as `globalPathOf` reads them (`code-globals.ts`), but of a name no scope around the read
 * declares (`globalReads`); none of another node.
 */
function globalPath(node: Node): readonly string[] | undefined {
  const names: string[] = [];
  let each = node;
  while (isPropertyAccessExpression(each) || isElementAccessExpression(each)) {
    const name = isPropertyAccessExpression(each) ? each.name.text : literalName(each);
    if (name === undefined) {
      return undefined;
    }
    names.unshift(name);
    each = unwrapped(each.expression);
  }
  if (!isIdentifier(each) || !globalReads(each.getSourceFile()).has(each)) {
    return undefined;
  }
  const path = [each.text, ...names];
  while (path.length > 1 && GLOBAL_OBJECTS.has(path[0] ?? '')) {
    path.shift();
  }
  return path;
}

/** The member `node` reads by a name written as it is: `stack` of `error.stack`, of `error['stack']`. */
function memberName(node: Node): string | undefined {
  if (isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  return isElementAccessExpression(node) ? literalName(node) : undefined;
}

/**
 * The frames an error was made in, where `node` reads them, by the name it reads them by — a member
 * of an error that answers of them, `stack` of one made there, caught, or a variable around it is
 * declared of, by a dot or in brackets (`framedRead`), or a member of `Error` one engine alone holds,
 * `Error.captureStackTrace` — as a shared module's are told (`settled.ts`): the engine's text of
 * where the code ran, which one document every visitor is answered with would hold of the first.
 */
function framesRead(node: Node): string | undefined {
  const aliased = aliasedFrameRead(node);
  if (aliased !== undefined) {
    return aliased;
  }
  if (framedRead(node) !== undefined) {
    return memberName(node) ?? framedInputName(node);
  }
  const path = globalPath(node)?.join('.');
  return path !== undefined && ENGINE_ERRORS.has(path) ? path : undefined;
}

/** The methods of a date's format that format the time they are called at, given no date. */
const FORMATS: ReadonlySet<string> = new Set(['format', 'formatToParts']);

/** The class of a date's format, as the global names it: what reading its time is said to read. */
const DATE_FORMAT = 'Intl.DateTimeFormat';

/**
 * Whether `node` is the class of a date's format: the global (`globalPath`), `Intl.DateTimeFormat`,
 * or what a variable around it is declared of — `const DateFormat = Intl.DateTimeFormat` — or takes
 * apart of `Intl` by its name, `const { DateTimeFormat } = Intl`, in turn.
 */
function isDateFormatClass(node: Expression, member: string | undefined): boolean {
  if (inheritedDateFormat(node, member)) return true;
  const seen = new Set<string>();
  for (let value = unwrapped(node); ;) {
    if (globalPath(value)?.join('.') === DATE_FORMAT) {
      return true;
    }
    if (!isIdentifier(value) || seen.has(value.text)) {
      return false;
    }
    seen.add(value.text);
    const initializer = initializerOf(value);
    if (initializer === undefined) {
      const taken = takenApartOf(value);
      return (
        taken !== undefined &&
        `${globalPath(unwrapped(taken.of))?.join('.')}.${taken.key}` === DATE_FORMAT
      );
    }
    value = unwrapped(initializer);
  }
}

/**
 * Whether `node` is a date's format: one the code makes there of its class (`isDateFormatClass`),
 * `new Intl.DateTimeFormat(…)`, `Intl.DateTimeFormat(…)`, or what a variable around it is declared
 * of, in turn (`initializerOf`).
 */
function isDateFormat(node: Expression, seen: Set<string>, member: string | undefined): boolean {
  const value = unwrapped(node);
  if (isNewExpression(value) || isCallExpression(value)) {
    return isDateFormatClass(value.expression, member);
  }
  if (!isIdentifier(value) || seen.has(value.text)) {
    return false;
  }
  seen.add(value.text);
  const initializer = initializerOf(value);
  return initializer !== undefined && isDateFormat(initializer, seen, member);
}

/** The original read retains a fresh stored formatter without retrying an earlier alias position. */
function dateFormatReceiver(
  expression: Expression,
  read: Node,
  member: string | undefined,
): boolean {
  const stored = storedIntlReceiver(expression, read);
  return stored === undefined
    ? isDateFormat(expression, new Set(), member)
    : isDateFormatClass(stored.expression, member);
}

/**
 * Whether `given`, what a call is handed, may hand it no date first: none, `undefined`, `void 0`,
 * or a spread, which may hand none, however it spreads them.
 */
function givesNoDate(given: readonly Expression[]): boolean {
  const [first] = given;
  const value = first === undefined ? undefined : unwrapped(first);
  return (
    value === undefined ||
    isVoidExpression(value) ||
    (isIdentifier(value) && value.text === 'undefined') ||
    given.some((each) => isSpreadElement(each))
  );
}

/**
 * Whether `node`, a member read, is what a call there calls, past what wraps it alike (`useOf`),
 * handed a date first: `formatter.format(date)`.
 */
function calledOfDate(node: Node): boolean {
  const { at, parent } = useOf(node);
  return isCallExpression(parent) && parent.expression === at && !givesNoDate(parent.arguments);
}

/**
 * Whether a member of the name `name` may be a date format's `format` or `formatToParts`: one of a
 * name the compile cannot read may.
 */
function mayFormat(name: string | undefined): boolean {
  return name === undefined || FORMATS.has(name);
}

/**
 * What the pattern `node` is an element of takes apart: a variable's or a parameter's initializer,
 * or what an assignment assigns, `({ format } = formatter)`; none of a rest of it, which copies an
 * object's own entries alone, nor of a pattern within another.
 */
function takenApartBy(node: Node): Expression | undefined {
  const pattern = node.parent;
  if (isBindingElement(node) && isObjectBindingPattern(pattern)) {
    const holder = pattern.parent;
    return node.dotDotDotToken === undefined &&
      (isVariableDeclaration(holder) || isParameterDeclaration(holder))
      ? holder.initializer
      : undefined;
  }
  if (
    !(isPropertyAssignment(node) || isShorthandPropertyAssignment(node)) ||
    !isObjectLiteralExpression(pattern)
  ) {
    return undefined;
  }
  const { at, parent } = useOf(pattern);
  return isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    parent.left === at
    ? parent.right
    : undefined;
}

/**
 * `Intl.DateTimeFormat`, where `node` reads a date format's `format` or `formatToParts`
 * (`isDateFormat`) — by a dot, in brackets, by a key the compile cannot read, taken apart,
 * `const { format } = formatter`, or by `Reflect.get` (`reflectsFormat`) — but to call it there of
 * a date, `formatter.format(date)`: called of none (`givesNoDate`), it formats the time it is
 * called at, as ECMA-402 says, and taken off its format it is a function bound to it, which does
 * wherever it is called of none, `const format = formatter.format; format()` — which the compile
 * does not follow there.
 */
function formatsNow(node: Node): string | undefined {
  if (borrowedDateFormatClock(node, isDateFormatClass)) return DATE_FORMAT;
  if (aliasedDateFormatClock(node, isDateFormatClass)) return DATE_FORMAT;
  const formats =
    isPropertyAccessExpression(node) || isElementAccessExpression(node)
      ? mayFormat(memberName(node)) &&
        !calledOfDate(node) &&
        dateFormatReceiver(node.expression, node, memberName(node))
      : takesFormat(node) || reflectsFormat(node);
  return formats ? DATE_FORMAT : undefined;
}

/**
 * Whether `node`, a source-known native `Reflect.get` (`reflectedRead`), takes a date format's
 * `format` or `formatToParts` off it — or what of it by a key the compile cannot read — of the
 * format, or of a written receiver the accessor runs on, but to call it there of a date.
 */
function reflectsFormat(node: Node): boolean {
  const read = reflectedRead(node);
  if (read === undefined || calledOfDate(node)) return false;
  const { key, receiver, target } = read;
  const names = key === undefined ? undefined : framedPropertyNames(key);
  const formats: readonly (string | undefined)[] =
    names === undefined ? [undefined] : names.filter((name) => FORMATS.has(name));
  return formats.some((name) => {
    return (
      dateFormatReceiver(target, node, name) ||
      (receiver !== undefined && dateFormatReceiver(receiver, node, name))
    );
  });
}

/**
 * Whether `node`, an element of a pattern, takes a date format's `format` or `formatToParts` apart
 * of it (`takenApartBy`), or what of it by a key the compile cannot read.
 */
function takesFormat(node: Node): boolean {
  const source = takenApartBy(node);
  return (
    source !== undefined &&
    mayFormat(patternKey(node)) &&
    dateFormatReceiver(source, node, patternKey(node))
  );
}

/** Whole constant constructor aliases preserve the native multipart body position. */
function multipartConstructor(node: Expression): string | undefined {
  const path = globalPath(unwrapped(node))?.join('.');
  if (path === 'Request' || path === 'Response') return path;
  if (framedNativeConstructor(node, MULTIPART_REQUESTS)) return 'Request';
  return framedNativeConstructor(node, MULTIPART_RESPONSES) ? 'Response' : undefined;
}

/**
 * What `node` reads that nothing tracks: a global (`untrackedRead`), an error's frames, the time
 * a date's format formats of no date (`formatsNow`), a File's or source-made event's timestamp,
 * or the random boundary a native Request or Response constructs of FormData.
 */
export function untrackedAt(node: Node): string | undefined {
  const platform = renderPlatformGlobal(node, globalPath);
  if (platform !== undefined) return platform;
  if (isIdentifier(node)) {
    if (isModuleDeclaration(node.parent) && node.parent.name === node) return undefined;
    return globalReads(node.getSourceFile()).has(node) ? untrackedRead(node) : undefined;
  }
  if (isNewExpression(node)) {
    const multipart = multipartMaking(node, multipartConstructor(node.expression));
    if (multipart !== undefined) return multipart;
  }
  if (
    isNewExpression(node) &&
    fileReadsClock(node, (expression) => globalPath(unwrapped(expression))?.join('.') === 'File')
  ) {
    return 'File.lastModified';
  }
  if (eventReadsClock(node)) {
    return 'Event.timeStamp';
  }
  return (
    framesRead(node) ??
    formatsNow(node) ??
    localDateInput(node) ??
    renderDateParser(node) ??
    renderDateConversion(node) ??
    renderLocalInput(node)
  );
}

/**
 * The first of what `at` finds among `nodes` that runs — outside the types, the imports and the
 * exports of names — and outside what `skips` says runs elsewhere: the functions they hold, where
 * what runs as a part renders is read, not what a handler runs later.
 */
export function firstIn(
  nodes: readonly Node[],
  at: (node: Node) => string | undefined,
  skips: (node: Node) => boolean,
): string | undefined {
  let found: string | undefined;
  const visit = (node: Node): void => {
    if (
      found !== undefined ||
      isAmbient(node) ||
      isTypePosition(node) ||
      isImportDeclaration(node) ||
      isExportDeclaration(node) ||
      skips(node)
    ) {
      return;
    }
    found = at(node);
    node.forEachChild(visit);
  };
  for (const node of nodes) {
    visit(node);
  }
  return found;
}
