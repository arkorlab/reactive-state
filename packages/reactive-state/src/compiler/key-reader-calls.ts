import {
  type CallExpression,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isCallExpression,
  isClassExpression,
  isElementAccessExpression,
  isFunctionLikeDeclaration,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  type Node,
  type ObjectLiteralExpression,
  type SpreadElement,
} from 'typescript/ast';

import { memberOf, peeled } from './literal-members.ts';

/**
 * Where a call reads a member of what it is given by a key the code writes: of a function of the
 * language's that does so (`KEY_READERS`), however the code writes the call. The code is read as the
 * language runs it: a function is called with a `this` and arguments, and `call`, `apply` and `bind`
 * of a function, `Reflect.apply` and a function `bind` made hand what they are given on — one to
 * another, bound again, given to each other. What each is given reaches the reader in order; a
 * spread of an array written is the elements it writes, and one of a list the code gives by a name
 * has a length it does not show — each length the code may give it (`LONGEST`) is read, so that a
 * key written past it is read where it may be the key; and a function the code does not show is not
 * followed.
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

/**
 * The longest a spread of a list the code gives by a name is read to have (each length from none),
 * and how many such spreads a call may write: a key is at most a few arguments in, and what a call
 * hands on takes a few from it. With as many as `SPREADS` the longest is one less, to keep the ways
 * they may be few; past them no length is tried, and a call that writes a reader and the key is read.
 */
const LONGEST = 4;
const SPREADS = 4;

/** How the code-globals module reads a global, a written text and a constant, so as not to read each other. */
export interface Reading {
  /** The names a read of a global goes by, joined by dots; none of another node. */
  readonly pathOf: (node: Node) => string | undefined;
  /** The text a node writes, a string; none of another node. */
  readonly textOf: (node: Node) => string | undefined;
  /** What a constant of the name `name` the code declares is initialized by, where nothing changes it or hands it on. */
  readonly initializerOf: (name: Identifier) => Expression | undefined;
}

/** What a call is given, each spread of a list written or of a length it is given (`LONGEST`) laid out. */
type Args = readonly Expression[];

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

/** What `args` hand on after the `this` they begin with, which `call`, `apply` and `bind` take and drop. */
function afterThis(args: Args): Args {
  return args.slice(1);
}

/** What a bound function is called with: what it was given, then what it is called with. */
function joined(given: Args, args: Args): Args {
  return [...given, ...args];
}

/** The keys written in `items`, given to a call, past what `apply` takes apart: `'constructor'` of `[fn, 'constructor']`. */
function written(items: readonly Expression[], reading: Reading, found: Set<Node>): void {
  for (const item of items) {
    const each = peeled(isSpreadElement(item) ? item.expression : item);
    if (!isSpreadElement(item) && reading.textOf(each) === 'constructor') {
      found.add(item);
    } else if (isArrayLiteralExpression(each)) {
      written(each.elements, reading, found);
    }
  }
}

/** Where the calls of a module that reach a reader of the language's are read, by what `Reading` gives. */
class Calls {
  readonly #reading: Reading;
  readonly #lengths: ReadonlyMap<Node, number>;

  constructor(reading: Reading, lengths: ReadonlyMap<Node, number>) {
    this.#reading = reading;
    this.#lengths = lengths;
  }

  /** What a call is given by `items`: each spread laid out — of an array written, its elements; of a list given by a name, as many of it as its length says. */
  #argsOf(items: readonly Expression[]): Args {
    return items.flatMap((item): Args => {
      if (!isSpreadElement(item)) {
        return [item];
      }
      const array = peeled(item.expression);
      return isArrayLiteralExpression(array)
        ? this.#argsOf(array.elements)
        : Array.from({ length: this.#lengths.get(item) ?? 0 }, () => item);
    });
  }

  /** What `method` of the function `self` is, given `args`, comes to: its call, or the function `bind` makes of it. */
  #callMethod(method: string, self: Fn | undefined, args: Args): Outcome | undefined {
    if (self === undefined) {
      return undefined;
    }
    const thisArg = this.#fnOf(args[0]);
    if (method === 'call') {
      return this.callFn(self, thisArg, afterThis(args));
    }
    if (method === 'apply') {
      return this.callFn(self, thisArg, this.#elementsOf(args[1]));
    }
    return {
      fn: { given: afterThis(args), kind: 'bound', self: thisArg, target: self },
      kind: 'made',
    };
  }

  /** What `apply` hands on of `list`, the array it is given: its elements; none of one given by a name. */
  #elementsOf(list: Expression | undefined): Args {
    const array = list === undefined ? undefined : peeled(list);
    return array !== undefined && isArrayLiteralExpression(array)
      ? this.#argsOf(array.elements)
      : [];
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
        const [target] = args;
        return target === undefined
          ? undefined
          : this.callFn(this.#fnOf(target), this.#fnOf(args[1]), this.#elementsOf(args[2]));
      }
      default: {
        return undefined;
      }
    }
  }

  /** What a call comes to, where the code writes the function it calls and the `this` of it. */
  madeBy(call: CallExpression): Outcome | undefined {
    const callee = peeled(call.expression);
    const args = this.#argsOf(call.arguments);
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

/** The spreads of a list the code gives by a name that `call` writes, past the functions it holds. */
function spreadsIn(call: CallExpression): readonly SpreadElement[] {
  const found: SpreadElement[] = [];
  const visit = (node: Node): void => {
    if (isFunctionLikeDeclaration(node) || isClassExpression(node)) {
      return;
    }
    if (isSpreadElement(node) && !isArrayLiteralExpression(peeled(node.expression))) {
      found.push(node);
    }
    node.forEachChild(visit);
  };
  call.forEachChild(visit);
  return found;
}

/** Whether `call` writes a reader of the language's, which a spread past `SPREADS` leaves no way to follow. */
function writesReader(call: CallExpression, reading: Reading): boolean {
  let found = false;
  const visit = (node: Node): void => {
    const path = isPropertyAccessExpression(node) ? reading.pathOf(node) : undefined;
    found ||= path !== undefined && KEY_READERS.has(path);
    node.forEachChild(visit);
  };
  call.forEachChild(visit);
  return found;
}

/** The lengths of `spreads`, each of those it may have (`LONGEST`), together: each way they may be. */
function lengthsOf(spreads: readonly SpreadElement[]): readonly ReadonlyMap<Node, number>[] {
  const longest = spreads.length < SPREADS ? LONGEST : LONGEST - 1;
  const domain = Array.from({ length: longest + 1 }, (_, length) => length);
  let ways: readonly ReadonlyMap<Node, number>[] = [new Map()];
  for (const spread of spreads) {
    ways = ways.flatMap((way) => domain.map((length) => new Map(way).set(spread, length)));
  }
  return ways;
}

/** Whether, of lengths `lengths` of the spreads it writes, `call` reads a key of `keys` of a reader. */
function readsKey(
  call: CallExpression,
  reading: Reading,
  lengths: ReadonlyMap<Node, number>,
  keys: ReadonlySet<Node>,
): boolean {
  const calls = new Calls(reading, lengths);
  let outcome = calls.madeBy(call);
  // A function made, called with nothing more, as often as it makes another.
  for (let made = 0; outcome?.kind === 'made' && made < FOLLOWED; made += 1) {
    outcome = calls.callFn(outcome.fn, undefined, []);
  }
  const key = outcome?.kind === 'called' ? outcome.args[1] : undefined;
  return (
    outcome?.kind === 'called' &&
    KEY_READERS.has(outcome.reader) &&
    key !== undefined &&
    keys.has(key)
  );
}

/**
 * Whether `call` reads a member by the key `'constructor'` the code writes, of a reader of the
 * language's (`KEY_READERS`): at the call, or the `bind`, whose arguments give the key — where a
 * `bind` is given it, the function it makes, called with nothing more, as often as it makes
 * another, reads it; once. Where a spread of a list the code gives by a name comes before the key,
 * the key is read if it is the key at any length the spread may have.
 */
export function readsConstructorKey(call: CallExpression, reading: Reading): boolean {
  const keys = new Set<Node>();
  written(call.arguments, reading, keys);
  if (keys.size === 0) {
    return false;
  }
  const spreads = spreadsIn(call);
  if (spreads.length > SPREADS) {
    return writesReader(call, reading);
  }
  return lengthsOf(spreads).some((lengths) => readsKey(call, reading, lengths, keys));
}
