import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isCallExpression,
  isElementAccessExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  type Node,
  type ObjectLiteralExpression,
} from 'typescript/ast';

import { memberOf, peeled } from './literal-members.ts';

/**
 * Where a call reads a member of what it is given by a key the code writes: of a function of the
 * language's that does so (`KEY_READERS`), however the code writes the call. The code is read as the
 * language runs it: a function is called with a `this` and arguments, and `call`, `apply` and `bind`
 * of a function, `Reflect.apply` and a function `bind` made hand what they are given on — one to
 * another, bound again, given to each other. What each is given reaches the reader in order, up to
 * a spread, past which where a value stands is for the code to tell; and a function the code does
 * not show is not followed.
 */

/** The functions of globals that read a member of what they are given by the key given next. */
const KEY_READERS: ReadonlySet<string> = new Set([
  'Object.getOwnPropertyDescriptor',
  'Reflect.get',
  'Reflect.getOwnPropertyDescriptor',
]);

/** The methods of a function that call it, or `bind` it for a call, on what they are given after the `this`. */
const METHODS: ReadonlySet<string> = new Set(['apply', 'bind', 'call']);

/** How many constants deep a value is followed to be one of the code's own, and how many functions made of functions. */
const FOLLOWED = 4;

/** How the code-globals module reads a global, a written text and a constant, so as not to read each other. */
export interface Reading {
  /** The names a read of a global goes by, joined by dots; none of another node. */
  readonly pathOf: (node: Node) => string | undefined;
  /** The text a node writes, a string; none of another node. */
  readonly textOf: (node: Node) => string | undefined;
  /** What a constant of the name `name` the code declares is initialized by, where nothing changes it or hands it on. */
  readonly initializerOf: (name: Identifier) => Expression | undefined;
}

/** What a call is given up to a spread; `open`: no spread, past which where a value stands is unknown. */
interface Args {
  readonly items: readonly Expression[];
  readonly open: boolean;
}

/**
 * A function, as the code writes it: a reader of the language's, `call`, `apply` or `bind` of a
 * function, `Reflect.apply`, or what `bind` made of one — which calls its function, as `self`, on
 * the arguments it was given first and what it is called with.
 */
type Fn =
  | { readonly kind: 'reader'; readonly reader: string }
  | { readonly kind: 'method'; readonly method: string }
  | { readonly kind: 'reflect-apply' }
  | {
      readonly kind: 'bound';
      readonly target: Fn;
      readonly self: Fn | undefined;
      readonly given: Args;
    };

/** What a call comes to: a reader called with arguments, or a function made. */
type Outcome =
  | { readonly kind: 'called'; readonly reader: string; readonly args: Args }
  | { readonly kind: 'made'; readonly fn: Fn };

/** `items` up to the first spread, past which where a value stands is for the code to tell. */
function untilSpread(items: readonly Expression[]): readonly Expression[] {
  const spread = items.findIndex((each) => isSpreadElement(each));
  return spread === -1 ? items : items.slice(0, spread);
}

function argsOf(items: readonly Expression[]): Args {
  const kept = untilSpread(items);
  return { items: kept, open: kept.length === items.length };
}

/** What `args` hand on after the `this` they begin with, which `call`, `apply` and `bind` take and drop. */
function afterThis(args: Args): Args {
  return { items: args.items.slice(1), open: args.open };
}

/** What a bound function is called with: what it was given, then what it is called with. */
function joined(given: Args, args: Args): Args {
  return given.open ? { items: [...given.items, ...args.items], open: args.open } : given;
}

/** The keys written in `items`, given to a call, past what `apply` takes apart: `'constructor'` of `[fn, 'constructor']`. */
function written(items: readonly Expression[], reading: Reading, found: Set<Node>): void {
  for (const item of items) {
    const each = peeled(item);
    if (reading.textOf(each) === 'constructor') {
      found.add(item);
    } else if (isArrayLiteralExpression(each)) {
      written(each.elements, reading, found);
    }
  }
}

/** Where the calls of a module that reach a reader of the language's are read, by what `Reading` gives. */
class Calls {
  readonly #reading: Reading;

  constructor(reading: Reading) {
    this.#reading = reading;
  }

  /** What `method` of the function `self` is, given `args`, comes to: its call, or the function `bind` makes of it. */
  #callMethod(method: string, self: Fn | undefined, args: Args): Outcome | undefined {
    if (self === undefined) {
      return undefined;
    }
    const thisArg = this.#fnOf(args.items[0]);
    if (method === 'call') {
      return this.callFn(self, thisArg, afterThis(args));
    }
    if (method === 'apply') {
      return this.callFn(self, thisArg, this.#elementsOf(args.items[1], args.open));
    }
    return {
      fn: { given: afterThis(args), kind: 'bound', self: thisArg, target: self },
      kind: 'made',
    };
  }

  /** What `apply` hands on of `list`, the array it is given: its elements, up to a spread; none of one given by a name. */
  #elementsOf(list: Expression | undefined, open: boolean): Args {
    if (list === undefined) {
      return { items: [], open };
    }
    const array = peeled(list);
    return isArrayLiteralExpression(array) ? argsOf(array.elements) : { items: [], open: false };
  }

  /** The function `expression` is, where the code writes one of those it follows. */
  #fnOf(expression: Expression | undefined): Fn | undefined {
    if (expression === undefined) {
      return undefined;
    }
    const each = peeled(expression);
    if (isCallExpression(each)) {
      const made = this.madeBy(each);
      return made?.kind === 'made' ? made.fn : undefined;
    }
    const path = this.#reading.pathOf(each);
    if (path === 'Reflect.apply') {
      return { kind: 'reflect-apply' };
    }
    if (path !== undefined && KEY_READERS.has(path)) {
      return { kind: 'reader', reader: path };
    }
    const method = this.#methodOf(each);
    return method === undefined ? undefined : { kind: 'method', method: method.method };
  }

  /**
   * The method of a function `callee` reads of what it stands on, `call` of `fn.call` — where that
   * stands on a function, or what may be one: none of a member the object it stands on has of its
   * own, `helper.call`, which is no function's.
   */
  #methodOf(
    callee: Expression,
  ): { readonly method: string; readonly receiver: Expression } | undefined {
    let method: string | undefined;
    if (isPropertyAccessExpression(callee)) {
      method = callee.name.text;
    } else if (isElementAccessExpression(callee)) {
      method = this.#reading.textOf(peeled(callee.argumentExpression));
    }
    if (
      method === undefined ||
      !METHODS.has(method) ||
      !(isPropertyAccessExpression(callee) || isElementAccessExpression(callee)) ||
      this.#reading.pathOf(callee) === 'Reflect.apply' ||
      this.#owns(callee.expression, method, 0)
    ) {
      return undefined;
    }
    return { method, receiver: callee.expression };
  }

  /**
   * Whether the code shows that `expression` has the member `method` of its own, which is no
   * function's: an object written, or a constant of one, with a function written for it — or none,
   * inherited from what has none.
   */
  #owns(expression: Expression, method: string, depth: number): boolean {
    const each = peeled(expression);
    if (isObjectLiteralExpression(each)) {
      return this.#literalOwns(each, method);
    }
    const initializer =
      isIdentifier(each) && depth < FOLLOWED ? this.#reading.initializerOf(each) : undefined;
    return initializer !== undefined && this.#owns(initializer, method, depth + 1);
  }

  /**
   * Whether an object written has `method` of its own that is no function's: a function written
   * for it, the last entry of the name, a spread or a computed name after it giving none; or none,
   * where nothing else brings one (`memberOf`).
   */
  #literalOwns(literal: ObjectLiteralExpression, method: string): boolean {
    return memberOf(literal, method, this.#reading.textOf) !== 'unknown';
  }

  /**
   * What `fn` called with `args` comes to, `self` its `this`: a reader, called; `call`, `apply` or
   * `bind` of the function `self` is; `Reflect.apply` given the function first; a bound function,
   * its function called on what it was given and what it is called with.
   */
  callFn(fn: Fn | undefined, self: Fn | undefined, args: Args): Outcome | undefined {
    if (fn === undefined) {
      return undefined;
    }
    switch (fn.kind) {
      case 'reader': {
        return { args, kind: 'called', reader: fn.reader };
      }
      case 'bound': {
        return this.callFn(fn.target, fn.self, joined(fn.given, args));
      }
      case 'method': {
        return this.#callMethod(fn.method, self, args);
      }
      case 'reflect-apply': {
        const [target] = args.items;
        return target === undefined
          ? undefined
          : this.callFn(
              this.#fnOf(target),
              this.#fnOf(args.items[1]),
              this.#elementsOf(args.items[2], args.open),
            );
      }
      default: {
        return undefined;
      }
    }
  }

  /** What a call comes to, where the code writes the function it calls and the `this` of it. */
  madeBy(call: CallExpression): Outcome | undefined {
    const callee = peeled(call.expression);
    const args = argsOf(call.arguments);
    const method = this.#methodOf(callee);
    if (method !== undefined) {
      return this.callFn(
        { kind: 'method', method: method.method },
        this.#fnOf(method.receiver),
        args,
      );
    }
    return this.callFn(this.#fnOf(callee), undefined, args);
  }
}

/**
 * Whether `call` reads a member by the key `'constructor'` the code writes, of a reader of the
 * language's (`KEY_READERS`): at the call, or the `bind`, whose arguments give the key — where a
 * `bind` is given it, the function it makes, called with nothing more, as often as it makes
 * another, reads it; once.
 */
export function readsConstructorKey(call: CallExpression, reading: Reading): boolean {
  const keys = new Set<Node>();
  written(call.arguments, reading, keys);
  if (keys.size === 0) {
    return false;
  }
  const calls = new Calls(reading);
  let outcome = calls.madeBy(call);
  // A function made, called with nothing more, as often as it makes another.
  for (let made = 0; outcome?.kind === 'made' && made < FOLLOWED; made += 1) {
    outcome = calls.callFn(outcome.fn, undefined, { items: [], open: true });
  }
  const key = outcome?.kind === 'called' ? outcome.args.items[1] : undefined;
  return (
    outcome?.kind === 'called' &&
    KEY_READERS.has(outcome.reader) &&
    key !== undefined &&
    keys.has(key)
  );
}
