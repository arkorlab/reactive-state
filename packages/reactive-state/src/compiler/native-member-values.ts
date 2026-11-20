import { type CallExpression, isBlock, isSourceFile, type Node } from 'typescript/ast';

import { callbackCreationEffect, earlierExpressionEffect } from './callback-evaluation.ts';

/** Finite native data constants and known methods of native listing results. */
const CONSTANTS: ReadonlySet<string> = new Set([
  'Math.E',
  'Math.LN2',
  'Math.LN10',
  'Math.LOG2E',
  'Math.LOG10E',
  'Math.PI',
  'Math.SQRT1_2',
  'Math.SQRT2',
  'Number.EPSILON',
  'Number.MAX_SAFE_INTEGER',
  'Number.MAX_VALUE',
  'Number.MIN_SAFE_INTEGER',
  'Number.MIN_VALUE',
]);

const TYPED_ARRAYS: ReadonlySet<string> = new Set([
  'BigInt64Array',
  'BigUint64Array',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
]);

const ARRAY_METHODS: ReadonlySet<string> = new Set([
  'at',
  'concat',
  'copyWithin',
  'entries',
  'every',
  'fill',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flat',
  'flatMap',
  'forEach',
  'includes',
  'indexOf',
  'join',
  'keys',
  'lastIndexOf',
  'map',
  'pop',
  'push',
  'reduce',
  'reduceRight',
  'reverse',
  'shift',
  'slice',
  'some',
  'sort',
  'splice',
  'toReversed',
  'toSorted',
  'toSpliced',
  'unshift',
  'values',
  'with',
]);

const STRING_METHODS: ReadonlySet<string> = new Set([
  'at',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'concat',
  'endsWith',
  'includes',
  'indexOf',
  'isWellFormed',
  'lastIndexOf',
  'localeCompare',
  'match',
  'matchAll',
  'normalize',
  'padEnd',
  'padStart',
  'repeat',
  'replace',
  'replaceAll',
  'search',
  'slice',
  'split',
  'startsWith',
  'substr',
  'substring',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'toLowerCase',
  'toUpperCase',
  'toWellFormed',
  'trim',
  'trimEnd',
  'trimLeft',
  'trimRight',
  'trimStart',
]);

const TEXT_LISTINGS: ReadonlySet<string> = new Set([
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'String',
]);

/** A finite native constant, including each concrete typed array constructor's element width. */
export function isNativeConstant(path: readonly string[]): boolean {
  const [root = '', member] = path;
  return (
    CONSTANTS.has(path.join('.')) ||
    (path.length === 2 && member === 'BYTES_PER_ELEMENT' && TYPED_ARRAYS.has(root))
  );
}

/** A known native method, rather than an arbitrary optional entry, on a listing result. */
export function isListingMethod(called: string, key: string): boolean {
  return (TEXT_LISTINGS.has(called) ? STRING_METHODS : ARRAY_METHODS).has(key);
}

/** Earlier application work can replace a listing function or the method on its result. */
export function quietListingRead(call: CallExpression): boolean {
  if (
    call.arguments.some((each) => callbackCreationEffect(each)) ||
    earlierExpressionEffect(call)
  ) {
    return false;
  }
  for (let each: Node = call; !isSourceFile(each); each = each.parent) {
    const { parent } = each;
    if (
      isBlock(parent) &&
      parent.statements.some(
        (statement) => statement.end <= each.pos && callbackCreationEffect(statement),
      )
    ) {
      return false;
    }
  }
  return true;
}
