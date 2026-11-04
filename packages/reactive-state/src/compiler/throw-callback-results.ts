import { type Expression, isBlock, isIdentifier, isReturnStatement } from 'typescript/ast';

import { type Answering, answersLater, parametersOf } from './answers.ts';
import { globalOf, unwrapped } from './bounded.ts';
import { constantValue, type Resolve } from './numbers.ts';
import { isBigIntWritten } from './throw-bigints.ts';
import { primitiveOf } from './throw-shapes.ts';
import { isSymbolWritten } from './throw-symbols.ts';

/** A simple synchronous callback's written result that its native consumer cannot convert. */
export function callbackResultThrows(
  fn: Answering,
  kind: 'number' | 'bigint' | 'string' | 'json' | 'object',
  resolve: Resolve | undefined,
): boolean {
  if (
    answersLater(fn) ||
    fn.body === undefined ||
    parametersOf(fn).some(
      (parameter) => !isIdentifier(parameter.name) || parameter.initializer !== undefined,
    )
  ) {
    return false;
  }
  let result: Expression | undefined;
  if (isBlock(fn.body)) {
    if (fn.body.statements.length === 0) {
      return kind === 'bigint' || kind === 'object';
    }
    const [only] = fn.body.statements;
    if (only === undefined || fn.body.statements.length !== 1 || !isReturnStatement(only)) {
      return false;
    }
    result = only.expression;
  } else {
    result = fn.body;
  }
  if (result === undefined) {
    return kind === 'bigint' || kind === 'object';
  }
  const value = unwrapped(result);
  if (isIdentifier(value) && globalOf(value) === undefined) {
    return false;
  }
  if (kind === 'object') {
    return primitiveResult(value, resolve);
  }
  if (kind === 'json') {
    return isBigIntWritten(value, undefined);
  }
  if (isSymbolWritten(value, resolve)) {
    return true;
  }
  if (kind === 'string') {
    return false;
  }
  if (kind === 'number') {
    return isBigIntWritten(value, undefined);
  }
  return bigintResultThrows(value);
}

/** A written primitive cannot be an iterator object or an iterator's result object. */
function primitiveResult(value: Expression, resolve: Resolve | undefined): boolean {
  return (
    primitiveOf(value, undefined) !== undefined ||
    isBigIntWritten(value, undefined) ||
    isSymbolWritten(value, resolve)
  );
}

/** A written primitive that the typed element's ToBigInt conversion cannot accept. */
function bigintResultThrows(value: Expression): boolean {
  if (primitiveOf(value, undefined) === 'nothing') {
    return true;
  }
  const constant = constantValue(value);
  if (typeof constant === 'number') {
    return true;
  }
  if (typeof constant === 'string') {
    try {
      BigInt(constant);
    } catch {
      return true;
    }
  }
  return false;
}
