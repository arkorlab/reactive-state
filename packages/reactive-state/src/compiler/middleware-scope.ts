import {
  type BindingName,
  type Identifier,
  isCallExpression,
  isComputedPropertyName,
  isIdentifier,
  isObjectBindingPattern,
  type Node,
  type ObjectBindingPattern,
} from 'typescript/ast';

import { useOf } from './code-globals.ts';
import type { MiddlewareNames } from './middleware-reads.ts';
import { middlewareThisRead } from './middleware-this.ts';
import { bindingIdentifiers, freeReads } from './scope.ts';

/** Lexical invocation state and parameter work that middleware extraction cannot preserve. */

const RECEIVER =
  'A route middleware does not read middleware-bound `this`: extraction writes ordinary functions with different receivers. Nested ordinary functions and classes keep their own receiver.';
const ARGUMENTS =
  'A route middleware does not read the middleware’s own `arguments`: its guard and envelope run with different arguments. Read its context and `next` by their declared names.';
const OWN_FUNCTION =
  'A route middleware does not read its own function name: extraction writes different functions for its parts. Read its context and next by their declared names, or import a helper.';
const PARAMETER_NEXT =
  'A route middleware context pattern reads `next`, whose parameter binding extraction removes from the guard. Read next only in the middleware body.';
const DIRECT_EVAL =
  'A route middleware contains no direct `eval`: extracting its guard and envelope changes the lexical bindings the call can read. Declare the code directly or import a helper.';
const OMITTED_BINDING =
  "An unused context binding has a default, computed key or destructuring work that the middleware's parts would omit: read the binding in the part that runs it, or remove the work. Parameter binding runs before the middleware body even when its names are unused.";

/** A free read that would see the generated function's invocation or lexical environment. */
function checkScopeRead(
  identifier: Identifier,
  names: MiddlewareNames,
  ownName: string | undefined,
  scope: ReadonlySet<string>,
): void {
  if (scope.has(identifier.text)) {
    return;
  }
  if (identifier.text === ownName) {
    names.fail(OWN_FUNCTION, identifier);
  }
  if (names.imports.has(identifier.text)) {
    return;
  }
  if (identifier.text === 'arguments') {
    names.fail(ARGUMENTS, identifier);
  } else if (identifier.text === 'eval') {
    const { at, parent } = useOf(identifier);
    if (
      isCallExpression(parent) &&
      parent.expression === at &&
      parent.questionDotToken === undefined
    ) {
      names.fail(DIRECT_EVAL, identifier);
    }
  }
}

/** Refuses reads that would see the generated function's invocation or lexical environment. */
export function checkMiddlewareScope(
  parameter: BindingName,
  body: Node,
  names: MiddlewareNames,
  ownName?: string,
): void {
  const receiver = middlewareThisRead(parameter) ?? middlewareThisRead(body);
  if (receiver !== undefined) names.fail(RECEIVER, receiver);
  const parameters = new Set(bindingIdentifiers(parameter).map((identifier) => identifier.text));
  for (const identifier of freeReads(parameter)) {
    if (identifier.text === names.next.text && !parameters.has(identifier.text)) {
      names.fail(PARAMETER_NEXT, identifier);
    }
    checkScopeRead(identifier, names, ownName, parameters);
  }
  const declared = new Set(names.names.topLevel);
  for (const name of names.imports.keys()) {
    declared.delete(name);
  }
  for (const identifier of freeReads(body)) {
    checkScopeRead(identifier, names, ownName, declared);
  }
}

/**
 * Object patterns are pruned by each part; an array binding with any retained name is copied
 * whole. Only an unused plain identifier can be omitted without running parameter work.
 */
function checkElided(
  pattern: ObjectBindingPattern,
  kept: ReadonlySet<string>,
  names: MiddlewareNames,
): void {
  for (const element of pattern.elements) {
    const { name, propertyName } = element;
    if (name === undefined) {
      continue;
    }
    const retained = bindingIdentifiers(name).some((identifier) => kept.has(identifier.text));
    if (retained) {
      if (isObjectBindingPattern(name)) {
        checkElided(name, kept, names);
      }
      continue;
    }
    let omitted: Node | undefined = element.initializer;
    if (propertyName !== undefined && isComputedPropertyName(propertyName)) {
      omitted ??= propertyName.expression;
    }
    if (!isIdentifier(name)) {
      omitted ??= name;
    }
    if (omitted !== undefined) {
      names.fail(OMITTED_BINDING, omitted);
    }
  }
}

/** Refuses defaults, computed keys and nested destructuring that no generated part would bind. */
export function checkContextElision(names: MiddlewareNames, kept: ReadonlySet<string>): void {
  const { context } = names;
  if (context?.kind === 'pattern') {
    checkElided(context.pattern, kept, names);
  }
}
