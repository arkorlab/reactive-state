import { types } from 'node:util';

import { VIEW_LIMITS } from '../program.ts';
import { readCollectionParts } from './collection-parts.ts';
import { methodOf } from './methods.ts';

/**
 * What a dynamic site's own functions spend computing of their inputs — which a view sends as it
 * chooses, within `VIEW_LIMITS.bytes` — so that the code the compile writes of a site turns no few
 * bytes into work or memory without bound: each value the code makes in what a site is computed of,
 * as it is made — what each call answers, what each `+`, template, array and object makes, what each
 * function a method is given answers (`items.flatMap((item) => …)`), and each item a list maps —
 * which the program counts (`$.counted(…)`, `compiler/counting.ts`), with its size: each element
 * and entry of it, however deep, each character of its text and of its entries' keys, and the
 * elements an object the language reads as an array says it holds. A call of a site's function
 * that spends more than `VIEW_LIMITS.steps` throws, and so does one whose code makes what holds a
 * method of the language's apart from what it is of (`LANGUAGE_METHODS`): a view's, the site's
 * refusal; a page's first render, the application's fault. While it runs, it makes no code of
 * text: what made a function, and the globals `eval` and `Function`, are sealed (`sealOnce`). What a
 * `shared` module's function computes of what it is given is the application's code, as it wrote
 * it — as a Server Function's is of what a request sends — and counts nothing but what it answers;
 * a module that reads `eval` or `Function`, or reaches them otherwise, is no shared one
 * (`compiler/modules.ts`, `compiler/code-globals.ts`).
 */

/** What the call of a site's function in progress has spent; none outside one. */
const budget: { spent: number | undefined } = { spent: undefined };

/** Whether what makes code of text is sealed, for good (`sealOnce`). */
const sealing = { done: false };

/**
 * `made`, a call of a site's function, held to `VIEW_LIMITS.steps` from nothing spent, and making
 * no code of text while it runs (`sealOnce`).
 */
export function withinSteps<T>(made: () => T): T {
  // Sealed before it spends: where it cannot be, it throws with no call in progress, and the next
  // call tries anew.
  sealOnce();
  const outer = budget.spent;
  budget.spent = 0;
  try {
    return made();
  } finally {
    budget.spent = outer;
  }
}

/** Whether a call of a site's function runs, of which what makes code of text is sealed. */
function running(): boolean {
  return budget.spent !== undefined;
}

/**
 * The prototypes of the functions that make code of the text they are given — `Function`, and its
 * async and generator kinds — whose `constructor` a site's code reaches of any function it holds,
 * however it spells that name (`fn['con' + 'structor']`), which no check of the compile's can read.
 */
const CODE_MAKERS: readonly unknown[] = [
  Function.prototype,
  Object.getPrototypeOf(async () => {
    await Promise.resolve();
  }),
  Object.getPrototypeOf(function* generator() {
    yield 0;
  }),
  Object.getPrototypeOf(async function* generator() {
    await Promise.resolve();
    yield 0;
  }),
];

function refuseCode(): never {
  throw new EvalError(
    "A dynamic site's code reads what made a function, which makes code of text: none while it runs.",
  );
}

/** The globals that make code of the text they are given, called: `eval`, `Function`. */
const CODE_GLOBALS: readonly string[] = ['eval', 'Function'];

/** What holds what makes code of text, by the key it holds it at, as it held it. */
interface Holder {
  readonly holder: Readonly<Record<string, unknown>>;
  readonly key: string;
  readonly held: PropertyDescriptor;
}

/**
 * Seals, once and for good, what makes code of text — each of `CODE_MAKERS`' `constructor`, and the
 * globals `eval` and `Function` (`CODE_GLOBALS`) — with an accessor that answers what it held, but
 * while a call of a site's function runs (`running`): then reading a constructor throws, and calling
 * `eval` or `Function` does — a direct `eval(text)` too, which, of what is not the language's own
 * `eval`, is a call like another. Nothing is put back after a call, so nothing one does — a
 * prototype it freezes — keeps them sealed past it, or unseals them within it. Where one cannot be
 * sealed — the application froze what holds it — no site's function runs: it throws, and the next
 * call tries anew. What a module took of them as it loaded, it holds as it took it: the
 * application's code, as it wrote it.
 */
function sealOnce(): void {
  if (sealing.done) {
    return;
  }
  const holders: Holder[] = [];
  const hold = (holder: Readonly<Record<string, unknown>>, key: string): void => {
    const held = Object.getOwnPropertyDescriptor(holder, key);
    if (held !== undefined) {
      holders.push({ held, holder, key });
    }
  };
  for (const prototype of CODE_MAKERS) {
    hold(prototype as Readonly<Record<string, unknown>>, 'constructor');
  }
  for (const name of CODE_GLOBALS) {
    hold(globalThis, name);
  }
  if (holders.some(({ held }) => held.configurable !== true)) {
    throw new EvalError(
      "What makes code of text cannot be sealed while a dynamic site's function runs — the application froze a function's prototype, or the global that holds it — so none runs.",
    );
  }
  for (const each of holders) {
    seal(each);
  }
  sealing.done = true;
}

/**
 * Seals what `holder` holds at `key` (`sealOnce`): a constructor, whose read throws while a call
 * runs; a global, which answers then what throws called or made with — the rest of it, its
 * `prototype` and its `Symbol.hasInstance`, as it is.
 */
function seal({ held, holder, key }: Holder): void {
  let value: unknown = 'value' in held ? held.value : held.get?.call(holder);
  const refusing =
    typeof value === 'function' && key !== 'constructor'
      ? new Proxy(value, { apply: refuseCode, construct: refuseCode })
      : undefined;
  Object.defineProperty(holder, key, {
    configurable: true,
    enumerable: held.enumerable === true,
    get(): unknown {
      if (!running()) {
        return value;
      }
      return refusing ?? refuseCode();
    },
    set(this: unknown, given: unknown): void {
      // Written on what inherits it, an entry of its own, as a value it held would make.
      if (this === holder) {
        value = given;
      } else {
        Object.defineProperty(this, key, {
          configurable: true,
          enumerable: true,
          value: given,
          writable: true,
        });
      }
    },
  });
}

/**
 * `value`, what the code of a site made — a call's answer, a `+`'s, a template, an array, an object,
 * what a function a method is given answered — counted against the call in progress.
 */
export function counted<T>(value: T): T {
  if (budget.spent !== undefined) {
    spend(1);
    measure(value);
  }
  return value;
}

/** The lib's inherited methods of all JavaScript values, rather than a boxed primitive. */
// eslint-disable-next-line @typescript-eslint/no-wrapper-object-types
type MethodObject = Object;
/** A receiver's own signature, with inherited Object methods only where its type has no key. */
type MethodValue<T, K extends PropertyKey> = K extends keyof NonNullable<T>
  ? NonNullable<T>[K]
  : MethodObject[K & keyof MethodObject];

/** A method captured once before its arguments, checked before the call spends its inputs. */
export function method<T, K extends keyof (MethodObject & NonNullable<T>)>(
  receiver: T,
  key: K,
): OmitThisParameter<MethodValue<T, K>> {
  return methodOf(receiver, key, running(), refuseUnmeasuredSpread);
}

/** Spends `steps`; past `VIEW_LIMITS.steps`, throws. */
function spend(steps: number): void {
  const spent = (budget.spent ?? 0) + steps;
  budget.spent = spent;
  if (spent > VIEW_LIMITS.steps) {
    throw new RangeError(
      `What a dynamic site is computed of took more than ${String(VIEW_LIMITS.steps)} steps of its inputs: the functions its methods are given are called, and answer, more than its inputs could need.`,
    );
  }
}

/** What `measure` reads next: a value, or the object it leaves, done reading what it holds. */
type Pending = { readonly value: unknown } | { readonly leaving: unknown };

/**
 * Spends the size of `value`: a step for each element and entry of it — by any key of its own — and
 * each character of text, an entry's key among them; and of an object the language reads as an
 * array, the elements it says it holds (`arrayLength`). What it holds more than once is counted each
 * time it is reached — but what holds itself, a cycle, which no JSON holds, once on the way — read as
 * deep as it nests, on a stack of its own rather than the engine's, which a deep one would overflow
 * before the steps run out. A method of the language's it holds apart from what it is of throws
 * (`LANGUAGE_METHODS`), and so does an integer of `bigint` (`refuseInteger`).
 */
function measure(value: unknown): void {
  // The objects on the way from `value` to what is read: one reached again among them is a cycle.
  const within = new Set<unknown>();
  const pending: Pending[] = [{ value }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if ('leaving' in next) {
      within.delete(next.leaving);
      continue;
    }
    const held = next.value;
    refuseProxy(held);
    if (typeof held === 'string') {
      spend(held.length);
    } else if (typeof held === 'bigint') {
      refuseInteger();
    } else if (typeof held === 'function') {
      refuseMethod(held);
    } else if (typeof held === 'object' && held !== null && !within.has(held)) {
      within.add(held);
      pending.push({ leaving: held });
      readCollectionParts(held, spend, (part) => {
        pending.push({ value: part });
      });
      readParts(held as Readonly<Record<PropertyKey, unknown>>, pending);
    }
  }
}

/**
 * Spends of `held` each array position, plus every other own entry and its key's characters,
 * putting each value on `pending`. Array iterators cannot hide indexed or extra own entries.
 */
function readParts(held: Readonly<Record<PropertyKey, unknown>>, pending: Pending[]): void {
  const length = Array.isArray(held) ? (held as readonly unknown[]).length : undefined;
  spend(length ?? arrayLength(held));
  // Every key of its own — a symbol's too, and one not enumerated — which `Object.entries` passes
  // over, though the object holds what it holds.
  for (const key of Reflect.ownKeys(held)) {
    if (length !== undefined && key === 'length') {
      continue;
    }
    const indexed = length !== undefined && indexedKey(key, length);
    if (!indexed) {
      spend(1 + (typeof key === 'string' ? key.length : 0));
    }
    readEntry(held, key, pending);
  }
}

/** A stored data entry, without invoking getters or an array's custom iterator. */
function readEntry(
  held: Readonly<Record<PropertyKey, unknown>>,
  key: string | symbol,
  pending: Pending[],
): void {
  const descriptor = Object.getOwnPropertyDescriptor(held, key);
  if (descriptor !== undefined && 'value' in descriptor) {
    pending.push({ value: descriptor.value });
  }
}

/** Whether a string is the canonical name of an indexed array position already counted. */
function indexedKey(key: string | symbol, length: number): boolean {
  if (typeof key !== 'string') {
    return false;
  }
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

/**
 * The language's own functions what follows reads a value's entries with, as they were as this
 * module loaded: one the application's code puts in the place of one later neither answers for the
 * check before `concat` (`refuseUnmeasuredSpread`) nor stops it.
 */
const INTRINSIC = Object.freeze({
  describe: Object.getOwnPropertyDescriptor,
  isArray: Array.isArray,
  isProxy: types.isProxy,
  prototypeOf: Object.getPrototypeOf,
  toBoolean: Boolean,
});

/** A Proxy cannot be inspected for size without executing otherwise unused application traps. */
function refuseProxy(value: unknown): void {
  if (INTRINSIC.isProxy(value)) {
    throw new TypeError(
      'A dynamic site made a Proxy intermediate, whose size cannot be measured without invoking application traps: return an ordinary value from the shared helper.',
    );
  }
}

/**
 * Refuses an integer of `bigint` in what a site's code makes — what a `shared` module's function
 * answers, the grammar refusing the site's own (`1n`, `BigInt(…)`): no JSON holds one, and an
 * operator makes one as large as another says, `one << count`, at once, before any step counts it.
 * The program counts what `*` and `<<` are computed of before they compute (`compiler/counting.ts`).
 */
function refuseInteger(): never {
  throw new TypeError(
    'What a dynamic site is computed of made an integer of `bigint`, which no JSON holds, and which an operator makes as large as another says at once, `one << count`, before a step counts it: compute it of numbers.',
  );
}

/**
 * The methods of the language's values — an array's, text's, a number's, a boolean's, an object's,
 * a function's — each of which takes what it is called on as its own, beyond the rules the grammar
 * holds it to by its name: `[].join`, called as an object's (`{ ...shape, join: [].join }.join()`),
 * joins it as an array as long as its `length` says; `''.padStart`, its text padded as long as it
 * is told. And what made each — `String`, `Array`, `Object` — whose own functions the grammar holds
 * to rules by the name it reads them of (`String.raw`). What a site's code makes holds none apart
 * from what it is of.
 */
const LANGUAGE_METHODS: ReadonlySet<unknown> = new Set(
  [
    Array.prototype,
    String.prototype,
    Number.prototype,
    Boolean.prototype,
    Object.prototype,
    Function.prototype,
  ].flatMap((prototype) => {
    return Reflect.ownKeys(prototype)
      .map((key): unknown => Object.getOwnPropertyDescriptor(prototype, key)?.value)
      .filter((called) => typeof called === 'function');
  }),
);

/**
 * The keys that reach what made a value, or what it is made of — `Array` of `[]`, by `constructor`
 * — or define what it answers; `REACHING` of `compiler/computed.ts`, of a key the code writes.
 */
const REACHING_KEYS: ReadonlySet<string> = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  '__proto__',
  'constructor',
]);

/**
 * `key`, by which a dynamic site's code reads a member it computes the name of — `item[key]`, which
 * the program writes `item[$.member(key)]` — refused where it is one of `REACHING_KEYS`: the grammar
 * refuses such a name where the code writes it (`.constructor`, `['__proto__']`), and this one it
 * computes, of what a view sends — `[][key]` of `constructor` is `Array`, whose `from` would make an
 * array as long as what it is given says.
 */
export function member<K>(key: K): K {
  const normalized = Reflect.ownKeys({ [key as PropertyKey]: true })[0] ?? '';
  if (typeof normalized !== 'symbol' && REACHING_KEYS.has(normalized)) {
    throw new TypeError(
      `A dynamic site's code reads a member by a key it computes that reaches what made a value, or what it is made of — \`${normalized}\` — which none reads.`,
    );
  }
  if (key === null || (typeof key !== 'object' && typeof key !== 'function')) {
    return key;
  }
  return normalized as K;
}

/** Throws where `called` is one of `LANGUAGE_METHODS`, held apart from what it is of. */
function refuseMethod(called: unknown): void {
  if (LANGUAGE_METHODS.has(called)) {
    throw new TypeError(
      "What a dynamic site is computed of holds a method of the language's apart from what it is of — `{ join: [].join }` — which, called as its own, would take what it is called on for an array or text as long as that says: none is held so.",
    );
  }
}

/**
 * The elements `value` stands for to the language's methods that read an object as an array, which
 * hold none of them — `concat` of one made spreadable (`Symbol.isConcatSpreadable`), `[...…]` of
 * one that iterates (`Symbol.iterator`) as an array does — as many as its `length` says, which
 * they read: of `{ ...shape, [spread]: true }`, a `length` a view sends. None of an object of
 * neither, whatever entry it names `length`.
 */
function arrayLength(value: Readonly<Record<PropertyKey, unknown>>): number {
  const spreadable = storedMember(value, Symbol.isConcatSpreadable);
  const iterator = storedMember(value, Symbol.iterator);
  const spreads = Boolean(spreadable);
  if (!spreads && typeof iterator !== 'function') {
    return 0;
  }
  const stored = storedMember(value, 'length');
  if (
    typeof stored === 'function' ||
    typeof stored === 'symbol' ||
    (typeof stored === 'object' && stored !== null)
  ) {
    return 0;
  }
  const length = Math.trunc(Number(stored));
  return Number.isNaN(length) || length < 0 ? 0 : length;
}

/** An own or inherited data member, without invoking accessors or passing a shadowing entry. */
function storedMember(value: Readonly<Record<PropertyKey, unknown>>, key: PropertyKey): unknown {
  const descriptor = storedDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

/** What an own or inherited member is, the first along the prototypes that holds it, of no trap. */
function storedDescriptor(value: unknown, key: PropertyKey): PropertyDescriptor | undefined {
  for (
    let current: unknown = value;
    current !== null && (typeof current === 'object' || typeof current === 'function');
  ) {
    refuseProxy(current);
    const descriptor = INTRINSIC.describe(current, key);
    if (descriptor !== undefined) {
      return descriptor;
    }
    current = INTRINSIC.prototypeOf(current);
  }
  return undefined;
}

/** `Array.prototype.concat`, which spreads what it is given as long as its `length` says. */
const CONCAT: unknown = Reflect.get(Array.prototype, 'concat');

/**
 * Refuses, before `concat` is called, what it would spread as long as the application's code says
 * as it is read: one an accessor makes spreadable, or one spread whose `length` an accessor answers,
 * or an object `concat` converts. `measure` runs no such code, and so counts what it holds of them
 * as no array's (`arrayLength`), where `concat` would walk each position the code says before a
 * step counts the array it makes. Of what else it spreads, what its stored entries say was counted
 * as it was made; an array spreads as long as it holds.
 */
function refuseUnmeasuredSpread(called: unknown, given: readonly unknown[]): void {
  if (called !== CONCAT) {
    return;
  }
  // By position, through no method of an array nor its iterator, either of which the application's
  // code may have replaced.
  // eslint-disable-next-line @typescript-eslint/prefer-for-of, unicorn/no-for-loop -- see above
  for (let index = 0; index < given.length; index += 1) {
    if (spreadUnmeasured(given[index])) {
      throw new TypeError(
        "A dynamic site gives `concat` what it would spread as long as the application's code says as it is read — what an accessor makes spreadable, or a `length` an accessor answers or that converts — whose size cannot be measured without running that code: return an ordinary value from the shared helper.",
      );
    }
  }
}

/** Whether `concat` would read whether `value` spreads, or how far, of the application's code. */
function spreadUnmeasured(value: unknown): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return false;
  }
  refuseProxy(value);
  const spreads = INTRINSIC.isArray(value)
    ? undefined
    : storedDescriptor(value, Symbol.isConcatSpreadable);
  if (spreads === undefined) {
    return false;
  }
  if (!('value' in spreads)) {
    return true;
  }
  // Held as one element, or spread as long as `length` says: of nothing, none.
  const spreading = INTRINSIC.toBoolean(spreads.value);
  const length = spreading ? storedDescriptor(value, 'length') : undefined;
  if (length === undefined) {
    return false;
  }
  if (!('value' in length)) {
    return true;
  }
  const stored: unknown = length.value;
  return typeof stored === 'function' || (typeof stored === 'object' && stored !== null);
}
