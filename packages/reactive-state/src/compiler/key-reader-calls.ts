import {
  type CallExpression,
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isCallExpression,
  isElementAccessExpression,
  isPropertyAccessExpression,
  isSpreadElement,
  isTypeAssertion,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { unwrapped } from './bounded.ts';

/**
 * Where a call reads a member of what it is given by a key the code writes: of a function of the
 * language's that does so (`KEY_READERS`), however the code writes the call — called, borrowed
 * through `call` or `apply`, bound by `bind` and called, or bound again, given to `call`, `apply` or
 * `bind` of another function, or to `Reflect.apply`. What each is given reaches the reader in order,
 * up to a spread, past which where a value stands is for the code to tell.
 */

/** The functions of globals that read a member of what they are given by the key given next. */
const KEY_READERS: ReadonlySet<string> = new Set([
  'Object.getOwnPropertyDescriptor',
  'Reflect.get',
  'Reflect.getOwnPropertyDescriptor',
]);

/**
 * The methods of a function that call it, or `bind` it for a call, on what they are given after the
 * `this` they take.
 */
const BORROWING: ReadonlySet<string> = new Set(['apply', 'bind', 'call']);

/**
 * What a function of a reader takes of what it is called with, before the arguments of the reader
 * follow, in order: the `this` of a `call`, `apply` or `bind` bound to it, the array of `apply`,
 * whose elements what follows is given by; what `bind` keeps, of which a function is made, not a call.
 */
type Taking = 'array' | 'rest' | 'this';

/** What each method of a function takes of what it is called with. */
const TAKING: Readonly<Record<string, readonly Taking[]>> = {
  apply: ['this', 'array'],
  bind: ['this', 'rest'],
  call: ['this'],
};

/** What the code-globals module reads a global and a written text by, so as not to read each other. */
export interface Reading {
  /** The names a read of a global goes by, joined by dots; none of another node. */
  readonly pathOf: (node: Node) => string | undefined;
  /** The text a node writes, a string; none of another node. */
  readonly textOf: (node: Node) => string | undefined;
}

/**
 * A function of the language that reads a member by a key, as the code writes it: the reader, the
 * arguments it is given first, whether more may follow (not past a spread), and what it takes of
 * what it is called with before they do (`Taking`).
 */
interface Reader {
  readonly reader: string;
  readonly args: readonly Expression[];
  readonly open: boolean;
  readonly queue: readonly Taking[];
}

/** A method of a function, `call`, `apply` or `bind`, or `Reflect.apply`, not yet given the function it acts on. */
interface Method {
  readonly method: string;
}

/** What a call of the code comes to: a call of a reader, or a function it makes of one. */
type Made =
  | {
      readonly kind: 'called';
      readonly reader: string;
      readonly args: readonly Expression[];
      readonly inherited: number;
    }
  | { readonly kind: 'made'; readonly value: Reader; readonly inherited: number };

/** What a call is given up to a spread; `open`: no spread, past which where a value stands is unknown. */
interface Args {
  readonly items: readonly Expression[];
  readonly open: boolean;
}

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

/**
 * What `apply` hands on of `list`, the array it is given: its elements, up to a spread; none of one
 * the code gives by a name.
 */
function elementsOf(list: Expression | undefined, open: boolean): Args {
  if (list === undefined) {
    return { items: [], open };
  }
  let array = unwrapped(list);
  // `unwrapped` leaves a cast in angle brackets: `<any>[run, 'constructor']` is the array within.
  while (isTypeAssertion(array)) {
    array = unwrapped(array.expression);
  }
  return isArrayLiteralExpression(array) ? argsOf(array.elements) : { items: [], open: false };
}

/**
 * What a call calls, past the parentheses, the casts and a comma's first operands around it — `(0,
 * Reflect.get.bind(null, fn))`, `(<any>Reflect.get.bind(null, fn))`, which `unwrapped` leaves.
 */
function calledOf(expression: Expression): Expression {
  let each = unwrapped(expression);
  for (;;) {
    if (isBinaryExpression(each) && each.operatorToken.kind === SyntaxKind.CommaToken) {
      each = unwrapped(each.right);
    } else if (isTypeAssertion(each)) {
      each = unwrapped(each.expression);
    } else {
      return each;
    }
  }
}

/** What a function of a reader is left of what it is given, once it has taken what is its own to take. */
interface Taken {
  /** What it has yet to take, where it waits for it. */
  readonly queue: readonly Taking[];
  readonly items: readonly Expression[];
  readonly open: boolean;
  /** Whether `apply` took all it is given. */
  readonly sealed: boolean;
  /** Whether a `bind` bound to it keeps what is left, of which a function is made. */
  readonly binding: boolean;
}

/**
 * What a function `fn` of a reader takes of what it is `given`, in order, called (`calling`) or
 * bound: the `this` of a `call`, `apply` or `bind` bound to it, the array of `apply`, whose elements
 * are what follows. None where a spread may be what it takes; it waits where it is bound before it is
 * given what it takes.
 */
function takeFrom(fn: Reader, given: Args, calling: boolean): Taken | undefined {
  const queue = [...fn.queue];
  let { items, open } = given;
  let sealed = false;
  let binding = false;
  while (queue.length > 0) {
    const [taking] = queue;
    if (taking === 'rest') {
      binding = true;
    } else if (!open && items.length === 0) {
      return undefined;
    } else if ((!calling || binding) && items.length === 0) {
      break;
    } else if (taking === 'this') {
      items = items.slice(1);
    } else {
      ({ items, open } = elementsOf(items[0], open));
      sealed = true;
    }
    queue.shift();
  }
  return { binding, items, open, queue, sealed };
}

/**
 * What a function `fn` of a reader comes to, called (`calling`) or bound, given `given`: what it
 * takes of it comes first (`takeFrom`), then the reader's own arguments follow those it has — past a
 * spread, where a value stands is unknown, and nothing more is added. A function `bind` is bound to
 * is made of what is left, not called.
 */
function feed(fn: Reader, given: Args, calling: boolean): Made | undefined {
  const taken = takeFrom(fn, given, calling);
  if (taken === undefined) {
    return undefined;
  }
  const inherited = fn.args.length;
  let { args, open } = fn;
  if (open && taken.queue.length === 0) {
    args = [...args, ...taken.items];
    open = taken.open && !taken.sealed;
  }
  if (calling && !taken.binding) {
    return { args, inherited, kind: 'called', reader: fn.reader };
  }
  const queue = calling || !taken.binding ? taken.queue : (['rest', ...taken.queue] as const);
  return { inherited, kind: 'made', value: { args, open, queue, reader: fn.reader } };
}

/** Where the calls of a module that reach a reader of the language's are read, by what `Reading` gives. */
class Calls {
  readonly #reading: Reading;

  constructor(reading: Reading) {
    this.#reading = reading;
  }

  /** What `Reflect.apply(fn, this, list)` comes to: `fn.apply(this, list)`. */
  #reflectApply(args: Args): Made | undefined {
    const [fn] = args.items;
    return fn === undefined
      ? undefined
      : this.#acts('apply', this.#valueOf(fn), { items: args.items.slice(1), open: args.open });
  }

  /** The function `expression` is: a reader, a method of a function, or what a bind made of a reader. */
  #valueOf(expression: Expression): Method | Reader | undefined {
    const each = calledOf(expression);
    if (isCallExpression(each)) {
      const made = this.madeBy(each);
      return made?.kind === 'made' ? made.value : undefined;
    }
    const path = this.#reading.pathOf(each);
    if (path === 'Reflect.apply') {
      return { method: 'reflect-apply' };
    }
    const member = this.#methodOf(each);
    if (member !== undefined) {
      return { method: member.method };
    }
    return path !== undefined && KEY_READERS.has(path)
      ? { args: [], open: true, queue: [], reader: path }
      : undefined;
  }

  /** The method of a function `callee` reads of what it stands on, `call` of `fn.call`, and that. */
  #methodOf(
    callee: Expression,
  ): { readonly method: string; readonly receiver: Expression } | undefined {
    if (isPropertyAccessExpression(callee)) {
      return BORROWING.has(callee.name.text)
        ? { method: callee.name.text, receiver: callee.expression }
        : undefined;
    }
    if (!isElementAccessExpression(callee)) {
      return undefined;
    }
    const method = this.#reading.textOf(unwrapped(callee.argumentExpression));
    return method !== undefined && BORROWING.has(method)
      ? { method, receiver: callee.expression }
      : undefined;
  }

  /**
   * What `method` — `call`, `apply` or `bind` — comes to, `target` the function it acts on, given
   * `args`: of a reader, its call, or the reader bound; of a method of a function, or `Reflect.apply`,
   * that method acting on the function it is given first, `fn.call.call(Reflect.get, null, fn, key)`.
   */
  #acts(method: string, target: Method | Reader | undefined, args: Args): Made | undefined {
    let current = method;
    let on = target;
    let given = args;
    while (on !== undefined) {
      if ('queue' in on) {
        return current === 'apply'
          ? feed(on, elementsOf(given.items[1], given.open), true)
          : feed(on, afterThis(given), current === 'call');
      }
      if (current === 'bind') {
        return this.#bound(on, given);
      }
      const next = current === 'apply' ? elementsOf(given.items[1], given.open) : afterThis(given);
      if (on.method === 'reflect-apply') {
        return this.#reflectApply(next);
      }
      const [first] = given.items;
      current = on.method;
      on = first === undefined ? undefined : this.#valueOf(first);
      given = next;
    }
    return undefined;
  }

  /**
   * What `bind` of a method of a function comes to, given `args`: a function that takes the `this`
   * of the method, and acts on the function `bind` was given first, with what follows.
   */
  #bound(target: Method, args: Args): Made | undefined {
    const [first] = args.items;
    const acted = first === undefined ? undefined : this.#valueOf(first);
    const taking = TAKING[target.method];
    return taking !== undefined && acted !== undefined && 'queue' in acted
      ? feed({ ...acted, queue: [...taking, ...acted.queue] }, afterThis(args), false)
      : undefined;
  }

  /**
   * What a call comes to, where it is of a reader, however the code writes it: called,
   * `Reflect.get(fn, key)`; borrowed, `Reflect.get.call(null, fn, key)`, `.apply(null, [fn, key])`;
   * bound, `.bind(null, fn)` — called, or bound again; `call`, `apply` and `bind` of a function
   * given the reader, `fn.call.bind(Reflect.get)`; or `Reflect.apply(Reflect.get, null, [fn, key])`
   * — none of another call.
   */
  madeBy(call: CallExpression): Made | undefined {
    const callee = calledOf(call.expression);
    const args = argsOf(call.arguments);
    if (this.#reading.pathOf(callee) === 'Reflect.apply') {
      return this.#reflectApply(args);
    }
    const member = this.#methodOf(callee);
    if (member !== undefined) {
      return this.#acts(member.method, this.#valueOf(member.receiver), args);
    }
    const fn = this.#valueOf(callee);
    return fn !== undefined && 'queue' in fn ? feed(fn, args, true) : undefined;
  }
}

/**
 * Whether `call` reads a member by the key `'constructor'` the code writes, of a reader of the
 * language's (`KEY_READERS`): at the call, or the `bind`, that first gives the key, once.
 */
export function readsConstructorKey(call: CallExpression, reading: Reading): boolean {
  const made = new Calls(reading).madeBy(call);
  if (made === undefined) {
    return false;
  }
  const { args, reader } = made.kind === 'called' ? made : made.value;
  const key = args[1];
  return (
    made.inherited <= 1 &&
    key !== undefined &&
    KEY_READERS.has(reader) &&
    reading.textOf(unwrapped(key)) === 'constructor'
  );
}
