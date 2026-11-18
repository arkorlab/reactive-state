import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isConditionalExpression,
  isElementAccessExpression,
  isIdentifier,
  isNewExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isRegularExpressionLiteral,
  isTemplateExpression,
  type NewExpression,
  SyntaxKind,
} from 'typescript/ast';

import { globalOf } from './bounded.ts';
import { type FrameDeclaration, frameDeclarationOf } from './framed-bindings.ts';
import {
  declarationValueExpressions,
  isNullishExpression,
  isPrimitiveExpression,
  isStableMember,
  memberNameOf,
  unwrapCalleeExpression,
} from './framed-template-argument-receivers.ts';
import { LOGICAL_OPERATORS } from './framed-template-argument-spreads.ts';
import { peeled } from './framed-written-targets.ts';

/**
 * Benign built-in global, namespace, prototype, and container-mutator classification for
 * `arguments` taint tracking.
 */

type BuiltInReceiverKind = 'array' | 'collection' | 'object' | 'primitive';

export interface BuiltInCallCheck {
  readonly isResolvedCallback: (expr: Expression) => boolean;
  readonly slots: ReadonlyMap<number, readonly Expression[]>;
}

const MAX_RECEIVER_DEPTH = 32;
const EMPTY_SEEN_DECLS: ReadonlySet<FrameDeclaration> = new Set();
const NO_EXPRESSIONS: readonly Expression[] = [];

const BENIGN_GLOBAL_CALLABLES: ReadonlySet<string> = new Set(
  [
    'AbortController AggregateError Array ArrayBuffer BigInt BigInt64Array BigUint64Array Blob',
    'Boolean DOMException DataView Date Error EvalError Float16Array Float32Array Float64Array',
    'FormData Headers Int16Array Int32Array Int8Array Map Number Object Promise RangeError',
    'ReferenceError RegExp Request Response Set SharedArrayBuffer String Symbol SyntaxError',
    'TextDecoder TextEncoder TypeError URIError URL URLSearchParams Uint16Array Uint32Array',
    'Uint8Array Uint8ClampedArray WeakMap WeakRef WeakSet atob btoa decodeURI decodeURIComponent',
    'encodeURI encodeURIComponent isFinite isNaN parseFloat parseInt structuredClone',
  ]
    .join(' ')
    .split(' '),
);

const BENIGN_GLOBAL_NAMESPACES: ReadonlySet<string> = new Set(
  'Array Atomics BigInt Date Intl JSON Map Math Number Object Promise Reflect RegExp Response String Symbol URL'.split(
    ' ',
  ),
);

const ARRAY_METHODS: ReadonlySet<string> = new Set(
  [
    'at concat copyWithin entries every fill filter find findIndex findLast findLastIndex flat',
    'flatMap forEach includes indexOf join keys lastIndexOf map pop push reduce reduceRight',
    'reverse shift slice some sort splice toLocaleString toReversed toSorted toSpliced toString',
    'unshift values with',
  ]
    .join(' ')
    .split(' '),
);

const ARRAY_CALLBACK_METHODS: ReadonlySet<string> = new Set(
  'every filter find findIndex findLast findLastIndex flatMap forEach map reduce reduceRight some sort toSorted'.split(
    ' ',
  ),
);

const COLLECTION_METHODS: ReadonlySet<string> = new Set(
  'add clear delete entries forEach get has keys set values'.split(' '),
);

const PRIMITIVE_METHODS: ReadonlySet<string> = new Set(
  [
    'at charAt charCodeAt codePointAt concat endsWith includes indexOf isWellFormed lastIndexOf',
    'localeCompare match matchAll normalize padEnd padStart repeat replace replaceAll search slice',
    'split startsWith substring toExponential toFixed toLocaleLowerCase toLocaleString',
    'toLocaleUpperCase toLowerCase toPrecision toString toUpperCase toWellFormed trim trimEnd',
    'trimStart valueOf',
  ]
    .join(' ')
    .split(' '),
);

const SHARED_OBJECT_PROTOTYPE_METHODS: ReadonlySet<string> = new Set([
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
]);

const MUTATING_METHODS: ReadonlySet<string> = new Set([
  'add',
  'append',
  'copyWithin',
  'fill',
  'push',
  'reverse',
  'set',
  'sort',
  'splice',
  'unshift',
]);

const OBJECT_MUTATORS: ReadonlySet<string> = new Set([
  'assign',
  'defineProperties',
  'defineProperty',
]);

const REFLECT_MUTATORS: ReadonlySet<string> = new Set(['defineProperty', 'set']);

const COLLECTION_CONSTRUCTORS: ReadonlySet<string> = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);

const PRIMITIVE_RETURNING_GLOBALS: ReadonlySet<string> = new Set(
  'BigInt Boolean Number String Symbol atob btoa decodeURI decodeURIComponent encodeURI encodeURIComponent isFinite isNaN parseFloat parseInt'.split(
    ' ',
  ),
);

const ARRAY_RETURNING_ARRAY_METHODS: ReadonlySet<string> = new Set(
  'concat filter flat flatMap map reverse slice sort splice toReversed toSorted toSpliced with'.split(
    ' ',
  ),
);

const PRIMITIVE_RETURNING_ARRAY_METHODS: ReadonlySet<string> = new Set(
  'every findIndex findLastIndex includes indexOf join lastIndexOf push some unshift'.split(' '),
);

const BUILTIN_OBJECT_CONSTRUCTORS: ReadonlySet<string> = new Set([
  'AggregateError',
  'Date',
  'Error',
  'EvalError',
  'Promise',
  'RangeError',
  'ReferenceError',
  'RegExp',
  'SyntaxError',
  'TypeError',
  'URIError',
  'URL',
  'URLSearchParams',
]);

export function isBenignGlobalCallable(id: Identifier, check: BuiltInCallCheck): boolean {
  if (globalOf(id) === undefined || !BENIGN_GLOBAL_CALLABLES.has(id.text)) return false;
  if (id.text === 'Promise') {
    return slotCallbacksResolved(check.slots.get(0), check.isResolvedCallback, false);
  }
  return true;
}

export function isBenignBuiltInMemberCall(
  receiver: Expression,
  method: string,
  check: BuiltInCallCheck,
): boolean {
  const file = receiver.getSourceFile();
  if (!isStableMember(file, method)) return false;
  const globalName = globalOf(receiver);
  if (globalName !== undefined) return isBenignNamespaceStaticCall(globalName, method, check);
  const kind = classifyBuiltInReceiver(receiver, EMPTY_SEEN_DECLS, 0);
  return kind !== undefined && isBenignInstanceMethodForKind(kind, method, check);
}

export function isBenignPrototypeMemberCall(
  protoOwner: Expression,
  method: string,
  check: BuiltInCallCheck,
): boolean {
  if (!isStableMember(protoOwner.getSourceFile(), method)) return false;
  const globalName = globalOf(protoOwner);
  if (globalName === 'Array') {
    return isBenignInstanceMethodForKind('array', method, check);
  }
  if (globalName === 'Object') return SHARED_OBJECT_PROTOTYPE_METHODS.has(method);
  if (globalName === 'Map' || globalName === 'Set') {
    return isBenignInstanceMethodForKind('collection', method, check);
  }
  if (globalName === 'String' || globalName === 'Number' || globalName === 'Boolean') {
    return isBenignInstanceMethodForKind('primitive', method, check);
  }
  return false;
}

export function knownMutatedTargetArguments(
  call: CallExpression | NewExpression,
  callee: Expression,
  slots: ReadonlyMap<number, readonly Expression[]>,
): readonly Expression[] {
  if (
    !isCallExpression(call) ||
    (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee))
  ) {
    return NO_EXPRESSIONS;
  }
  const method = memberNameOf(callee);
  if (method === undefined) return NO_EXPRESSIONS;
  const receiver = peeled(callee.expression);
  if (isStaticMutator(receiver, method)) return slots.get(0) ?? NO_EXPRESSIONS;
  if (method !== 'call' && method !== 'apply') return NO_EXPRESSIONS;
  if (!isPropertyAccessExpression(receiver) && !isElementAccessExpression(receiver)) {
    return NO_EXPRESSIONS;
  }
  const innerMethod = memberNameOf(receiver);
  if (innerMethod === undefined) return NO_EXPRESSIONS;
  if (method === 'call' && isStaticMutator(peeled(receiver.expression), innerMethod)) {
    return slots.get(1) ?? NO_EXPRESSIONS;
  }
  return MUTATING_METHODS.has(innerMethod) ? (slots.get(0) ?? NO_EXPRESSIONS) : NO_EXPRESSIONS;
}

export function isDirectMutatingMethod(callee: Expression): boolean {
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return false;
  const method = memberNameOf(callee);
  return (
    method !== undefined &&
    MUTATING_METHODS.has(method) &&
    globalOf(peeled(callee.expression)) === undefined
  );
}

function isStaticMutator(receiver: Expression, method: string): boolean {
  const globalName = globalOf(receiver);
  return (
    (globalName === 'Object' && OBJECT_MUTATORS.has(method)) ||
    (globalName === 'Reflect' && REFLECT_MUTATORS.has(method))
  );
}

function isBenignNamespaceStaticCall(
  globalName: string,
  method: string,
  check: BuiltInCallCheck,
): boolean {
  if (!BENIGN_GLOBAL_NAMESPACES.has(globalName)) return false;
  if (globalName === 'Reflect' && (method === 'apply' || method === 'construct')) return false;
  if (
    (globalName === 'Array' && (method === 'from' || method === 'fromAsync')) ||
    (method === 'groupBy' && (globalName === 'Object' || globalName === 'Map')) ||
    (globalName === 'JSON' && method === 'parse')
  ) {
    return slotCallbacksResolved(check.slots.get(1), check.isResolvedCallback, true);
  }
  if (globalName === 'JSON' && method === 'stringify') {
    return slotReplacerResolved(check.slots.get(1), check.isResolvedCallback);
  }
  return true;
}

function isBenignInstanceMethodForKind(
  kind: BuiltInReceiverKind,
  method: string,
  check: BuiltInCallCheck,
): boolean {
  if (kind === 'primitive') {
    if (!PRIMITIVE_METHODS.has(method)) return false;
    return (
      (method !== 'replace' && method !== 'replaceAll') ||
      slotCallbacksResolved(check.slots.get(1), check.isResolvedCallback, true)
    );
  }
  if (kind === 'array') {
    if (!ARRAY_METHODS.has(method)) return false;
    return (
      !ARRAY_CALLBACK_METHODS.has(method) ||
      slotCallbacksResolved(check.slots.get(0), check.isResolvedCallback, method === 'sort')
    );
  }
  if (kind === 'collection') {
    if (!COLLECTION_METHODS.has(method)) return false;
    return (
      method !== 'forEach' ||
      slotCallbacksResolved(check.slots.get(0), check.isResolvedCallback, false)
    );
  }
  return SHARED_OBJECT_PROTOTYPE_METHODS.has(method);
}

function slotCallbacksResolved(
  candidates: readonly Expression[] | undefined,
  isResolvedCallback: (expr: Expression) => boolean,
  allowPrimitives: boolean,
): boolean {
  if (candidates === undefined) return true;
  for (const candidate of candidates) {
    const inner = unwrapCalleeExpression(candidate);
    if (isNullishExpression(inner)) continue;
    if (allowPrimitives && isPrimitiveExpression(inner)) continue;
    if (!isResolvedCallback(inner)) return false;
  }
  return true;
}

function slotReplacerResolved(
  candidates: readonly Expression[] | undefined,
  isResolvedCallback: (expr: Expression) => boolean,
): boolean {
  if (candidates === undefined) return true;
  for (const candidate of candidates) {
    const inner = unwrapCalleeExpression(candidate);
    if (isNullishExpression(inner) || isPrimitiveExpression(inner)) continue;
    if (classifyBuiltInReceiver(inner, EMPTY_SEEN_DECLS, 0) === 'array') continue;
    if (!isResolvedCallback(inner)) return false;
  }
  return true;
}

function classifyBuiltInReceiver(
  raw: Expression,
  seen: ReadonlySet<FrameDeclaration>,
  depth: number,
): BuiltInReceiverKind | undefined {
  if (depth > MAX_RECEIVER_DEPTH) return undefined;
  const expr = unwrapCalleeExpression(raw);
  const direct = classifyDirectLiteralOrUnary(expr);
  if (direct !== undefined) return direct;
  if (isIdentifier(expr)) return classifyIdentifierReceiver(expr, seen, depth);
  if (isCallExpression(expr) || isNewExpression(expr))
    return classifyCallReceiver(expr, seen, depth);
  return classifyCompoundReceiver(expr, seen, depth);
}

function classifyDirectLiteralOrUnary(expr: Expression): BuiltInReceiverKind | undefined {
  if (expr.kind === SyntaxKind.NullKeyword || isNullishExpression(expr)) return undefined;
  if (isPrimitiveExpression(expr) || isTemplateExpression(expr)) return 'primitive';
  if (isArrayLiteralExpression(expr)) return 'array';
  if (isRegularExpressionLiteral(expr)) return 'object';
  if (isPrefixUnaryExpression(expr) || isPostfixUnaryExpression(expr)) return 'primitive';
  return undefined;
}

function classifyIdentifierReceiver(
  id: Identifier,
  seen: ReadonlySet<FrameDeclaration>,
  depth: number,
): BuiltInReceiverKind | undefined {
  const decl = frameDeclarationOf(id);
  if (decl === undefined || seen.has(decl)) return undefined;
  const values = declarationValueExpressions(decl);
  if (values === undefined) return undefined;
  const [first, ...rest] = values;
  if (first === undefined) return undefined;
  const nextSeen = new Set([...seen, decl]);
  let merged = classifyBuiltInReceiver(first, nextSeen, depth + 1);
  for (const item of rest) {
    if (merged === undefined) return undefined;
    merged = mergeReceiverKinds(merged, classifyBuiltInReceiver(item, nextSeen, depth + 1));
  }
  return merged;
}

function classifyCompoundReceiver(
  expr: Expression,
  seen: ReadonlySet<FrameDeclaration>,
  depth: number,
): BuiltInReceiverKind | undefined {
  if (isConditionalExpression(expr)) {
    return mergeReceiverKinds(
      classifyBuiltInReceiver(expr.whenTrue, seen, depth + 1),
      classifyBuiltInReceiver(expr.whenFalse, seen, depth + 1),
    );
  }
  if (!isBinaryExpression(expr)) return undefined;
  const op = expr.operatorToken.kind;
  if (op === SyntaxKind.CommaToken || op === SyntaxKind.EqualsToken) {
    return classifyBuiltInReceiver(expr.right, seen, depth + 1);
  }
  if (LOGICAL_OPERATORS.has(op)) {
    return mergeReceiverKinds(
      classifyBuiltInReceiver(expr.left, seen, depth + 1),
      classifyBuiltInReceiver(expr.right, seen, depth + 1),
    );
  }
  return 'primitive';
}

function classifyCallReceiver(
  call: CallExpression | NewExpression,
  seen: ReadonlySet<FrameDeclaration>,
  depth: number,
): BuiltInReceiverKind | undefined {
  const callee = unwrapCalleeExpression(call.expression);
  const globalName = globalOf(callee);
  if (globalName !== undefined) return classifyGlobalCallReturn(globalName, isNewExpression(call));
  if (isNewExpression(call)) return undefined;
  if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return undefined;
  const method = memberNameOf(callee);
  if (method === undefined || !isStableMember(call.getSourceFile(), method)) return undefined;
  const recv = unwrapCalleeExpression(callee.expression);
  const ns = globalOf(recv);
  if (ns !== undefined) return classifyNamespaceCallReturn(ns, method);
  const recvKind = classifyBuiltInReceiver(recv, seen, depth + 1);
  return recvKind === undefined ? undefined : classifyInstanceMethodReturn(recvKind, method);
}

function classifyGlobalCallReturn(
  name: string,
  isConstruct: boolean,
): BuiltInReceiverKind | undefined {
  if (!isConstruct && PRIMITIVE_RETURNING_GLOBALS.has(name)) return 'primitive';
  if (name === 'Array') return 'array';
  if (isConstruct && COLLECTION_CONSTRUCTORS.has(name)) return 'collection';
  if (BUILTIN_OBJECT_CONSTRUCTORS.has(name)) return 'object';
  return undefined;
}

function classifyNamespaceCallReturn(ns: string, method: string): BuiltInReceiverKind | undefined {
  if (ns === 'Array' && (method === 'from' || method === 'of')) return 'array';
  if (
    ns === 'Object' &&
    (method === 'entries' ||
      method === 'getOwnPropertyNames' ||
      method === 'keys' ||
      method === 'values')
  ) {
    return 'array';
  }
  if (ns === 'Reflect' && method === 'ownKeys') return 'array';
  if (
    ns === 'Math' ||
    ns === 'String' ||
    ns === 'Number' ||
    (ns === 'JSON' && method === 'stringify')
  ) {
    return 'primitive';
  }
  return undefined;
}

function mergeReceiverKinds(
  left: BuiltInReceiverKind | undefined,
  right: BuiltInReceiverKind | undefined,
): BuiltInReceiverKind | undefined {
  return left !== undefined && left === right ? left : undefined;
}

function classifyInstanceMethodReturn(
  kind: BuiltInReceiverKind,
  method: string,
): BuiltInReceiverKind | undefined {
  if (method === 'toString' || method === 'toLocaleString') return 'primitive';
  if (kind === 'primitive') return classifyPrimitiveMethodReturn(method);
  if (kind !== 'array') return undefined;
  if (ARRAY_RETURNING_ARRAY_METHODS.has(method)) return 'array';
  return PRIMITIVE_RETURNING_ARRAY_METHODS.has(method) ? 'primitive' : undefined;
}

function classifyPrimitiveMethodReturn(method: string): BuiltInReceiverKind | undefined {
  if (method === 'split') return 'array';
  if (method === 'match' || method === 'matchAll') return undefined;
  return PRIMITIVE_METHODS.has(method) ? 'primitive' : undefined;
}
