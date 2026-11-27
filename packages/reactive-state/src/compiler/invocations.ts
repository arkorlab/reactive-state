import {
  type CallExpression,
  type ElementAccessExpression,
  type Expression,
  isCallExpression,
  isElementAccessExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  type PropertyAccessExpression,
} from 'typescript/ast';

import { type Answering, givenAt, omitsAt } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { literalKey } from './exported-values.ts';
import { globalPath } from './global-answers.ts';

/**
 * What a call invokes, and what it gives each parameter of what it invokes, as the checks of what
 * no JSON holds read it (`json-values.ts`): of a function called through `call`, `apply` and
 * `bind` too — `make.call(null, value)`, `make.apply(null, values)`, `make.bind(null, value)()`,
 * `Reflect.apply(make, null, values)` — the function, and what the call gives it past what it
 * gives `this`.
 */

/**
 * What a call gives the parameter at `index` of `fn`, which it invokes; and, where the compile reads
 * it, whether it may give it nothing, or what may be `undefined`, of which the parameter takes its
 * default (`omitsAt`) — of none, it may.
 */
export interface Given {
  (fn: Answering, index: number): readonly Expression[];
  readonly omits?: ((index: number) => boolean) | undefined;
  /**
   * What the call writes where the parameter at `index` stands: of a call of the function's name
   * that spreads nothing, its argument there. None of `call`, `apply` or `bind`, whose arguments
   * the compile reads as what any parameter may be given, nor past a spread.
   */
  readonly written?: ((index: number) => Expression | undefined) | undefined;
}

/**
 * What a call invokes through `call`, `apply`, `bind` or `Reflect.apply`: the function, and what it
 * gives it (`invoked`); of `bind` alone, a function (`bound`); of what the compile cannot read — a
 * function a spread hands `Reflect.apply` — anything (`unread`).
 */
export type Through =
  | { readonly kind: 'bound' }
  | { readonly kind: 'invoked'; readonly target: Expression; readonly given: Given }
  | { readonly kind: 'unread' };

/** What `call` gives each parameter of what it calls, by its place (`givenAt`). */
export function givenOf(call: CallExpression): Given {
  const passed = call.arguments;
  const isPlaced = !passed.some((each) => isSpreadElement(each));
  return Object.assign(passedAs(passed), {
    written: (index: number) => (isPlaced ? passed[index] : undefined),
  });
}

/** What `passed`, the arguments of a call by place, give each parameter (`Given`). */
function passedAs(passed: readonly Expression[]): Given {
  return Object.assign((fn: Answering, index: number) => givenAt(passed, fn, index), {
    omits: (index: number) => omitsAt(passed, index),
  });
}

/**
 * What `call` invokes through `call`, `apply` or `bind` (`Through`): of `target.call(self, …)`,
 * `target`, given what follows `self`; of `target.apply(self, values)`, `target`, any parameter of
 * it given any of `values`; of `target.bind(self, …)(…)`, `target`, given what `bind` and the call
 * give it in turn; of `target.bind(…)` alone, a function; of `Reflect.apply(target, self,
 * values)`, as of `target.apply(self, values)`; none of any other call. Past a spread where `self`
 * stands, any parameter may be given anything the call is given.
 */
export function throughOf(call: CallExpression): Through | undefined {
  const callee = unwrapped(call.expression);
  if (globalPath(callee)?.join('.') === 'Reflect.apply') {
    const [target, self, values] = call.arguments;
    return target === undefined || isSpreadElement(target)
      ? { kind: 'unread' }
      : applied(target, self, values);
  }
  if (isCallExpression(callee)) {
    const bound = unwrapped(callee.expression);
    if (!isMember(bound) || nameOf(bound) !== 'bind') {
      return undefined;
    }
    const [self, ...partial] = callee.arguments;
    return invoked(bound.expression, self, [...partial, ...call.arguments]);
  }
  if (!isMember(callee)) {
    return undefined;
  }
  const name = nameOf(callee);
  if (name === 'bind') {
    return { kind: 'bound' };
  }
  if (name === 'call') {
    const [self, ...passed] = call.arguments;
    return invoked(callee.expression, self, passed);
  }
  if (name !== 'apply') {
    return undefined;
  }
  const [self, values] = call.arguments;
  return applied(callee.expression, self, values);
}

/**
 * `target` invoked as `apply` invokes it, `this` given `self`, any parameter given any of `values`
 * — past a spread where `self` stands, anything either holds.
 */
function applied(
  target: Expression,
  self: Expression | undefined,
  values: Expression | undefined,
): Through {
  const handed = [self, values].flatMap((each) => {
    if (each === undefined) {
      return [];
    }
    return [isSpreadElement(each) ? each.expression : each];
  });
  const given = self !== undefined && isSpreadElement(self) ? handed : handed.slice(1);
  return { given: () => given, kind: 'invoked', target };
}

/**
 * `target` invoked, given `passed` by place, past `self`, which it gives `this` — or, of a spread
 * where `self` stands, anything either holds.
 */
function invoked(
  target: Expression,
  self: Expression | undefined,
  passed: readonly Expression[],
): Through {
  if (self === undefined || !isSpreadElement(self)) {
    return { given: passedAs(passed), kind: 'invoked', target };
  }
  const all = [self, ...passed].map((each) => (isSpreadElement(each) ? each.expression : each));
  return { given: () => all, kind: 'invoked', target };
}

/** Whether `node` reads a member, by its name or in brackets. */
function isMember(node: Expression): node is ElementAccessExpression | PropertyAccessExpression {
  return isPropertyAccessExpression(node) || isElementAccessExpression(node);
}

/** The name the member `node` reads: by name, or of text in brackets; none of another key. */
function nameOf(node: ElementAccessExpression | PropertyAccessExpression): string | undefined {
  return isPropertyAccessExpression(node)
    ? node.name.text
    : literalKey(unwrapped(node.argumentExpression));
}
