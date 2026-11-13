import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  isStringLiteral,
  isTypeAssertion,
  isVariableDeclaration,
  isVariableDeclarationList,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';
import { globalPathOf } from './code-globals.ts';
import { frameBindingOf, frameMemberName } from './framed-bindings.ts';
import { framedAppliedArguments } from './framed-keys.ts';

/**
 * What a call of a native of the language's comes to, however the code writes the call. The code
 * is read as the language runs it: a function is called with a `this` and arguments, and `call`,
 * `apply` and `bind` of a function, `Reflect.apply` and a function `bind` made hand what they are
 * given on, one to another, bound again, given to each other. What each is given reaches the native
 * in order, a spread of a written list as the entries it stands for; a function the code does not
 * show is not followed.
 */

/** The methods of a function that call it, or `bind` it for a call, on what they are given after the `this`. */
const METHODS: ReadonlySet<string> = new Set(['apply', 'bind', 'call']);

/** The methods of a function, as the language names them. */
const FUNCTION_METHODS: ReadonlyMap<string, 'apply' | 'bind' | 'call'> = new Map([
  ['Function.prototype.apply', 'apply'],
  ['Function.prototype.bind', 'bind'],
  ['Function.prototype.call', 'call'],
]);

/** How many constants deep a value is followed to be one of the code's own. */
const FOLLOWED = 8;

/** How many steps are taken to tell what one call comes to: past them, the call is not followed. */
const STEPS = 400;

/**
 * A function, as the code writes it: a native, a method of a function (`call`, `apply`, `bind`),
 * `Reflect.apply`, or what `bind` made of one, which calls its function as `self` on the arguments it
 * was given first and what it is called with.
 */
type Fn =
  | { readonly kind: 'native'; readonly path: string }
  | { readonly kind: 'method'; readonly method: string }
  | { readonly kind: 'reflect-apply' }
  | {
      readonly kind: 'bound';
      readonly target: Fn;
      readonly self: Fn | undefined;
      readonly given: readonly Expression[];
    };

/** What a call comes to: a native called with arguments, or a function made. */
export type Outcome =
  | { readonly kind: 'called'; readonly path: string; readonly args: readonly Expression[] }
  | { readonly kind: 'made'; readonly fn: Fn };

/**
 * What a call is given after its first, the `this` that `call`, `apply` and `bind` take and drop;
 * none where a spread, which may be any number of them, comes first.
 */
function afterThis(args: readonly Expression[]): readonly Expression[] | undefined {
  const [first, ...rest] = args;
  return first !== undefined && isSpreadElement(first) ? undefined : rest;
}

/**
 * What a call past the parentheses, the casts and a comma's first operands around it calls:
 * `(0, Object.assign)`, `(<any>Object.assign)`.
 */
function calledOf(expression: Expression): Expression {
  let each = unwrapped(expression);
  for (;;) {
    if (isBinaryExpression(each) && each.operatorToken.kind === SyntaxKind.CommaToken)
      each = unwrapped(each.right);
    else if (isTypeAssertion(each)) each = unwrapped(each.expression);
    else return each;
  }
}

/** The initializer of the constant a name stands for whole. */
export function constantInitializer(name: Identifier): Expression | undefined {
  const held = frameBindingOf(name);
  const declaration = held?.keys.length === 0 ? held.binding : undefined;
  if (declaration === undefined || !isVariableDeclaration(declaration)) return undefined;
  const list = declaration.parent;
  const constant =
    isVariableDeclarationList(list) && /^const\b/u.test(list.getText(list.getSourceFile()));
  return constant ? declaration.initializer : undefined;
}

/** Whether `expression` is a value the code writes that is no function: an object, an array, a literal, a constant of one. */
function isPlain(expression: Expression, depth: number): boolean {
  const each = calledOf(expression);
  if (
    isObjectLiteralExpression(each) ||
    isArrayLiteralExpression(each) ||
    isStringLiteral(each) ||
    isNoSubstitutionTemplateLiteral(each) ||
    isNumericLiteral(each)
  )
    return true;
  const initializer =
    isIdentifier(each) && depth < FOLLOWED ? constantInitializer(each) : undefined;
  return initializer !== undefined && isPlain(initializer, depth + 1);
}

/**
 * The call's arguments in order, each spread of a written list, or of a constant list nothing
 * changes, replaced by the entries it stands for; a spread the compile cannot read stays one. A
 * list is expanded each time it is spread, but never within itself.
 */
export function writtenArguments(
  call: CallExpression,
  given: readonly Expression[] = call.arguments,
): readonly Expression[] {
  type Listed = readonly (readonly Expression[])[];
  const written: Expression[] = [];
  const pending = given.toReversed().map((node) => ({ node, within: [] as Listed }));
  for (let each = pending.pop(); each !== undefined; each = pending.pop()) {
    const listed = isSpreadElement(each.node)
      ? framedAppliedArguments(call, each.node.expression)
      : undefined;
    if (listed === undefined || each.within.includes(listed)) written.push(each.node);
    else {
      const within = [...each.within, listed];
      for (const node of listed.toReversed()) pending.push({ node, within });
    }
  }
  return written;
}

/** Where the calls of a module that reach one of the natives are read. */
class Calls {
  readonly #call: CallExpression;
  readonly #natives: ReadonlySet<string>;
  #steps = 0;

  constructor(call: CallExpression, natives: ReadonlySet<string>) {
    this.#call = call;
    this.#natives = natives;
  }

  /** Whether one more step may be taken. */
  #step(): boolean {
    this.#steps += 1;
    return this.#steps <= STEPS;
  }

  /** What `method` of the function `self` is, given `args`, comes to: its call, or the function `bind` makes of it. */
  #callMethod(
    method: string,
    self: Fn | undefined,
    args: readonly Expression[],
  ): Outcome | undefined {
    const rest = afterThis(args);
    if (self === undefined || rest === undefined) return undefined;
    const thisArg = this.#fnOf(args[0]);
    if (method === 'call') return this.callFn(self, thisArg, rest);
    if (method === 'bind')
      return { fn: { given: rest, kind: 'bound', self: thisArg, target: self }, kind: 'made' };
    const elements = this.#elementsOf(args[1]);
    return elements === undefined ? undefined : this.callFn(self, thisArg, elements);
  }

  /** What `apply` hands on of `list`, the array it is given: its entries, a spread of a written list among them. */
  #elementsOf(list: Expression | undefined): readonly Expression[] | undefined {
    if (list === undefined) return [];
    const listed = framedAppliedArguments(this.#call, list);
    return listed === undefined ? undefined : writtenArguments(this.#call, listed);
  }

  /** The function `expression` is, where the code writes one of those it follows. */
  #fnOf(expression: Expression | undefined, held = 0): Fn | undefined {
    if (expression === undefined || held > FOLLOWED || !this.#step()) return undefined;
    const each = calledOf(expression);
    if (isCallExpression(each)) {
      const made = this.madeBy(each);
      return made?.kind === 'made' ? made.fn : undefined;
    }
    const path = globalPathOf(each)?.join('.');
    if (path === 'Reflect.apply') return { kind: 'reflect-apply' };
    if (path !== undefined && this.#natives.has(path)) return { kind: 'native', path };
    const given = path === undefined ? undefined : FUNCTION_METHODS.get(path);
    if (given !== undefined) return { kind: 'method', method: given };
    const method = this.#methodOf(each);
    if (method !== undefined) return { kind: 'method', method: method.method };
    const initializer = isIdentifier(each) ? constantInitializer(each) : undefined;
    return initializer === undefined ? undefined : this.#fnOf(initializer, held + 1);
  }

  /**
   * The method of a function `callee` reads of what it stands on, `call` of `fn.call`: none of a
   * member of an object or an array the code writes, `helper.call`, which is its own, and none of
   * `Reflect.apply`, which is no `apply`.
   */
  #methodOf(
    callee: Expression,
  ): { readonly method: string; readonly receiver: Expression } | undefined {
    if (!isPropertyAccessExpression(callee) && !isElementAccessExpression(callee)) return undefined;
    const method = frameMemberName(callee);
    if (
      method === undefined ||
      !METHODS.has(method) ||
      globalPathOf(callee)?.join('.') === 'Reflect.apply' ||
      isPlain(callee.expression, 0)
    )
      return undefined;
    return { method, receiver: callee.expression };
  }

  /**
   * What `fn` called with `args` comes to, `self` its `this`: a native, called; `call`, `apply` or
   * `bind` of the function `self` is; `Reflect.apply` given the function first; a bound function,
   * its function called on what it was given and what it is called with.
   */
  callFn(
    fn: Fn | undefined,
    self: Fn | undefined,
    args: readonly Expression[],
  ): Outcome | undefined {
    if (fn === undefined || !this.#step()) return undefined;
    switch (fn.kind) {
      case 'native': {
        return { args, kind: 'called', path: fn.path };
      }
      case 'bound': {
        return this.callFn(fn.target, fn.self, [...fn.given, ...args]);
      }
      case 'method': {
        return this.#callMethod(fn.method, self, args);
      }
      case 'reflect-apply': {
        const [target, thisArg, list] = args;
        const elements = this.#elementsOf(list);
        if (elements === undefined || target === undefined || isSpreadElement(target))
          return undefined;
        return this.callFn(this.#fnOf(target), this.#fnOf(thisArg), elements);
      }
      default: {
        return undefined;
      }
    }
  }

  /** What a call comes to, where the code writes the function it calls and the `this` of it. */
  madeBy(call: CallExpression): Outcome | undefined {
    const callee = calledOf(call.expression);
    const args = writtenArguments(call);
    const method = this.#methodOf(callee);
    if (method !== undefined)
      return this.callFn(
        { kind: 'method', method: method.method },
        this.#fnOf(method.receiver),
        args,
      );
    return this.callFn(this.#fnOf(callee), undefined, args);
  }
}

/**
 * The native one of `natives` names that a call runs, however it is written, and the arguments it
 * is given: none for a call of anything else, or of a function the code does not show.
 */
export function calledNative(
  call: CallExpression,
  natives: ReadonlySet<string>,
): { readonly path: string; readonly args: readonly Expression[] } | undefined {
  const outcome = new Calls(call, natives).madeBy(call);
  return outcome?.kind === 'called' ? { path: outcome.path, args: outcome.args } : undefined;
}
