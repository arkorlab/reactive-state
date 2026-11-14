import type { Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isErased, readsCodeGlobal } from '../src/compiler/code-globals.ts';

/**
 * A function of the language's that reads a member by the key it is given, `Reflect.get`, reads it
 * however the code writes the call, as `Reflect.get(fn, 'constructor')` does: through `call`,
 * `apply` and `bind` — one of them given to another, `run.call.bind(Reflect.get)`,
 * or bound again, `Reflect.get.bind(null).bind(null, fn)` — and through `Reflect.apply`. The
 * methods of a function are those of any function, `fn.call`, `Reflect.get.call`. What each
 * of them is given after the `this` it takes reaches the reader in order, up to a spread, past which
 * where a value stands is for the code to tell. The key reads at the call that first gives it,
 * once: where a `bind` is given it, the `bind` is the read; where the call is, the call is. What the
 * code does not show — a function it holds by a name, an array it gives by a name, a key past a
 * spread — is not read.
 *
 * `call`, `apply` and `bind` are read by their names, of whatever they are read of: an object that
 * writes one of its own, or none, is not told from a function, and the code that gives a reader's
 * key past it is refused (the rows that end `, refused`) — which is rare, and no member of an object
 * is followed to tell. The rows of such objects that read nothing are the ones the code does not
 * give a reader's key.
 */

const CASES = [
  // `bind` of what `bind` made.
  {
    reads: ["Reflect.get.bind(null).bind(null, run)('constructor')"],
    source: "return Reflect.get.bind(null).bind(null, run)('constructor')(text)();",
    what: 'a key the call of a reader bound twice is given',
  },
  {
    reads: ["Reflect.get.bind(null, run).bind(null)('constructor')"],
    source: "return Reflect.get.bind(null, run).bind(null)('constructor')(text)();",
    what: 'a key given to the call of a reader bound again, given no arguments',
  },
  {
    reads: ["Reflect.get.bind(null).bind(null)(run, 'constructor')"],
    source: "return Reflect.get.bind(null).bind(null)(run, 'constructor')(text)();",
    what: 'the function and the key given to the call of a reader bound twice',
  },
  {
    reads: ["Reflect.get.bind(null).bind(null).bind(null, run)('constructor')"],
    source: "return Reflect.get.bind(null).bind(null).bind(null, run)('constructor')(text)();",
    what: 'a key the call of a reader bound three times is given',
  },
  {
    reads: ["Reflect.get.bind(null).bind(null, run, 'constructor')"],
    source: "return Reflect.get.bind(null).bind(null, run, 'constructor')()(text)();",
    what: 'a key the second `bind` is given',
  },
  {
    reads: ["Reflect.get.bind(null, run).bind(null, 'constructor')"],
    source: "return Reflect.get.bind(null, run).bind(null, 'constructor')()(text)();",
    what: 'a key the second `bind` is given after the function',
  },
  {
    reads: ["Reflect.get.bind(null).bind(null, run).call(null, 'constructor')"],
    source: "return Reflect.get.bind(null).bind(null, run).call(null, 'constructor')(text)();",
    what: 'a key the `call` of a reader bound twice is given',
  },
  {
    reads: ["Reflect.get.bind(null).bind(null, run).apply(null, ['constructor'])"],
    source: "return Reflect.get.bind(null).bind(null, run).apply(null, ['constructor'])(text)();",
    what: 'a key the `apply` of a reader bound twice is given',
  },
  {
    reads: ["(0, Reflect.get.bind(null)).bind(null, run)('constructor')"],
    source: "return (0, Reflect.get.bind(null)).bind(null, run)('constructor')(text)();",
    what: 'a reader bound past a comma, then again',
  },
  // `call`, `apply` and `bind` given to a function: the methods of a function, bound or called.
  {
    reads: ["run.call.bind(Reflect.get)(null, run, 'constructor')"],
    source: "return run.call.bind(Reflect.get)(null, run, 'constructor')(text)();",
    what: '`call` of a function bound to the reader, called',
  },
  {
    reads: ["run.apply.bind(Reflect.get)(null, [run, 'constructor'])"],
    source: "return run.apply.bind(Reflect.get)(null, [run, 'constructor'])(text)();",
    what: '`apply` bound to the reader, called',
  },
  {
    reads: ["run.bind.bind(Reflect.get)(null, run, 'constructor')"],
    source: "return run.bind.bind(Reflect.get)(null, run, 'constructor')()(text)();",
    what: '`bind` bound to the reader, called',
  },
  {
    reads: ["Reflect.get.call.bind(Reflect.get)(null, run, 'constructor')"],
    source: "return Reflect.get.call.bind(Reflect.get)(null, run, 'constructor')(text)();",
    what: '`call` of the reader bound to the reader',
  },
  {
    reads: ["Reflect.get.apply.bind(Reflect.get)(null, [run, 'constructor'])"],
    source: "return Reflect.get.apply.bind(Reflect.get)(null, [run, 'constructor'])(text)();",
    what: '`apply` of the reader bound to the reader',
  },
  {
    reads: ["run.call.bind(Reflect.get, null, run, 'constructor')"],
    source: "return run.call.bind(Reflect.get, null, run, 'constructor')()(text)();",
    what: 'a key `call` is bound to, with the reader',
  },
  {
    reads: ["run.call.bind(Reflect.get, null)(run, 'constructor')"],
    source: "return run.call.bind(Reflect.get, null)(run, 'constructor')(text)();",
    what: 'the key given to `call` bound to the reader and a `this`',
  },
  {
    reads: ["run.apply.bind(Reflect.get, null)([run, 'constructor'])"],
    source: "return run.apply.bind(Reflect.get, null)([run, 'constructor'])(text)();",
    what: 'the array given to `apply` bound to the reader and a `this`',
  },
  {
    reads: ["run.apply.bind(Reflect.get, null, [run, 'constructor'])"],
    source: "return run.apply.bind(Reflect.get, null, [run, 'constructor'])()(text)();",
    what: 'an array `apply` is bound to, with the reader and a `this`',
  },
  {
    reads: ["run.call.bind(Reflect.get).bind(null, null, run)('constructor')"],
    source: "return run.call.bind(Reflect.get).bind(null, null, run)('constructor')(text)();",
    what: '`call` bound to the reader, bound again',
  },
  {
    reads: ["run.call.bind(Reflect.get).call(null, null, run, 'constructor')"],
    source: "return run.call.bind(Reflect.get).call(null, null, run, 'constructor')(text)();",
    what: '`call` bound to the reader, borrowed',
  },
  {
    reads: ["run.apply.bind(Reflect.get).apply(null, [null, [run, 'constructor']])"],
    source: "return run.apply.bind(Reflect.get).apply(null, [null, [run, 'constructor']])(text)();",
    what: '`apply` bound to the reader, applied',
  },
  {
    reads: ["run.call.call(Reflect.get, null, run, 'constructor')"],
    source: "return run.call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: '`call` called on the reader',
  },
  {
    reads: ["run.call.apply(Reflect.get, [null, run, 'constructor'])"],
    source: "return run.call.apply(Reflect.get, [null, run, 'constructor'])(text)();",
    what: '`call` applied to the reader',
  },
  {
    reads: ["run.apply.call(Reflect.get, null, [run, 'constructor'])"],
    source: "return run.apply.call(Reflect.get, null, [run, 'constructor'])(text)();",
    what: '`apply` called on the reader',
  },
  {
    reads: ["run.apply.apply(Reflect.get, [null, [run, 'constructor']])"],
    source: "return run.apply.apply(Reflect.get, [null, [run, 'constructor']])(text)();",
    what: '`apply` applied to the reader',
  },
  {
    reads: ["run.bind.call(Reflect.get, null, run, 'constructor')"],
    source: "return run.bind.call(Reflect.get, null, run, 'constructor')()(text)();",
    what: '`bind` called on the reader, given a key',
  },
  {
    reads: ["run.bind.apply(Reflect.get, [null, run, 'constructor'])"],
    source: "return run.bind.apply(Reflect.get, [null, run, 'constructor'])()(text)();",
    what: '`bind` applied to the reader, given a key',
  },
  {
    reads: ["run.bind.call(Reflect.get, null, run)('constructor')"],
    source: "return run.bind.call(Reflect.get, null, run)('constructor')(text)();",
    what: 'a key the call of what `bind` made of the reader is given',
  },
  {
    reads: ["Reflect.get.call.call(Reflect.get, null, run, 'constructor')"],
    source: "return Reflect.get.call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: '`call` of the reader, called on the reader',
  },
  {
    reads: ["(function () {}).call.call(Reflect.get, null, run, 'constructor')"],
    source: "return (function () {}).call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: '`call` of another function, called on the reader',
  },
  // `Reflect.apply`.
  {
    reads: ["Reflect.apply(Reflect.get, null, [run, 'constructor'])"],
    source: "return Reflect.apply(Reflect.get, null, [run, 'constructor'])(text)();",
    what: 'the reader, applied by `Reflect.apply`',
  },
  {
    reads: ["Reflect.apply(Reflect.get.bind(null, run), null, ['constructor'])"],
    source: "return Reflect.apply(Reflect.get.bind(null, run), null, ['constructor'])(text)();",
    what: 'a bound reader, applied by `Reflect.apply`',
  },
  {
    reads: ["Reflect.apply(Reflect.get.call, Reflect.get, [null, run, 'constructor'])"],
    source:
      "return Reflect.apply(Reflect.get.call, Reflect.get, [null, run, 'constructor'])(text)();",
    what: '`call` of the reader, applied to the reader by `Reflect.apply`',
  },
  {
    reads: ["Reflect.apply(run.call, Reflect.get, [null, run, 'constructor'])"],
    source: "return Reflect.apply(run.call, Reflect.get, [null, run, 'constructor'])(text)();",
    what: '`call` applied to the reader by `Reflect.apply`',
  },
  {
    reads: ["Reflect.apply(run.bind, Reflect.get, [null, run, 'constructor'])"],
    source: "return Reflect.apply(run.bind, Reflect.get, [null, run, 'constructor'])()(text)();",
    what: '`bind` applied to the reader by `Reflect.apply`',
  },
  {
    reads: ["globalThis.Reflect.apply(Reflect.get, null, [run, 'constructor'])"],
    source: "return globalThis.Reflect.apply(Reflect.get, null, [run, 'constructor'])(text)();",
    what: '`Reflect.apply` read of the global object',
  },
  {
    reads: ["(0, Reflect.apply)(Reflect.get, null, [run, 'constructor'])"],
    source: "return (0, Reflect.apply)(Reflect.get, null, [run, 'constructor'])(text)();",
    what: '`Reflect.apply` read past a comma',
  },
  {
    reads: ["Reflect.apply(Reflect.get, null, <any>[run, 'constructor'])"],
    source: "return Reflect.apply(Reflect.get, null, <any>[run, 'constructor'])(text)();",
    what: 'an array in a cast in angle brackets, given to `Reflect.apply`',
  },
  // `Reflect.apply`, bound or borrowed: the function it acts on is an argument, not the `this`.
  {
    reads: ["Reflect.apply.bind(null, Reflect.get)(null, [run, 'constructor'])"],
    source: "return Reflect.apply.bind(null, Reflect.get)(null, [run, 'constructor'])(text)();",
    what: '`Reflect.apply` bound to the reader, called',
  },
  {
    reads: ["Reflect.apply.bind(null, Reflect.get, null, [run, 'constructor'])"],
    source: "return Reflect.apply.bind(null, Reflect.get, null, [run, 'constructor'])()(text)();",
    what: 'an array `Reflect.apply` is bound to, with the reader',
  },
  {
    reads: ["Reflect.apply.call(null, Reflect.get, null, [run, 'constructor'])"],
    source: "return Reflect.apply.call(null, Reflect.get, null, [run, 'constructor'])(text)();",
    what: '`Reflect.apply` borrowed through `call`',
  },
  {
    reads: ["Reflect.apply.apply(null, [Reflect.get, null, [run, 'constructor']])"],
    source: "return Reflect.apply.apply(null, [Reflect.get, null, [run, 'constructor']])(text)();",
    what: '`Reflect.apply` borrowed through `apply`',
  },
  {
    reads: ["run.call.call(Reflect.apply, null, Reflect.get, null, [run, 'constructor'])"],
    source:
      "return run.call.call(Reflect.apply, null, Reflect.get, null, [run, 'constructor'])(text)();",
    what: '`Reflect.apply` given to `call` of a function',
  },
  {
    reads: ["Reflect.apply.bind(null).bind(null, Reflect.get)(null, [run, 'constructor'])"],
    source:
      "return Reflect.apply.bind(null).bind(null, Reflect.get)(null, [run, 'constructor'])(text)();",
    what: '`Reflect.apply` bound twice',
  },
  // A method of a function bound to a method: what it acts on is given when it is called.
  {
    reads: ["run.call.bind(run.call)(Reflect.get, null, run, 'constructor')"],
    source: "return run.call.bind(run.call)(Reflect.get, null, run, 'constructor')(text)();",
    what: '`call` bound to `call`, given the reader',
  },
  {
    reads: ["run.call.bind(run.call, Reflect.get, null, run, 'constructor')"],
    source: "return run.call.bind(run.call, Reflect.get, null, run, 'constructor')()(text)();",
    what: '`call` bound to `call`, with the reader and a key',
  },
  {
    reads: ["run.apply.bind(run.call)(Reflect.get, [null, run, 'constructor'])"],
    source: "return run.apply.bind(run.call)(Reflect.get, [null, run, 'constructor'])(text)();",
    what: '`apply` bound to `call`, given the reader',
  },
  {
    reads: ["run.call.bind(run.apply)(Reflect.get, null, [run, 'constructor'])"],
    source: "return run.call.bind(run.apply)(Reflect.get, null, [run, 'constructor'])(text)();",
    what: '`call` bound to `apply`, given the reader',
  },
  {
    reads: ["run.bind.bind(run.call)(Reflect.get, null, run)('constructor')"],
    source: "return run.bind.bind(run.call)(Reflect.get, null, run)('constructor')(text)();",
    what: '`bind` bound to `call`, given the reader, then a key',
  },
  {
    reads: ["run.call.call(run.call, Reflect.get, null, run, 'constructor')"],
    source: "return run.call.call(run.call, Reflect.get, null, run, 'constructor')(text)();",
    what: '`call` called on `call`',
  },
  // An apply array consumed: what it leaves of what a function takes is not given later.
  {
    reads: [],
    source:
      "return run.apply.bind(run.call.bind(Reflect.get.bind(null, obj)), null, [])(null, 'constructor');",
    what: 'an empty array `apply` is bound to, the key given after it',
  },
  {
    reads: [],
    source:
      "return run.apply.bind(run.call.bind(Reflect.get.bind(null, obj)), null, [null])(null, 'constructor');",
    what: 'an array of the `this` alone `apply` is bound to, the key given after it',
  },
  {
    reads: [
      "run.apply.bind(run.call.bind(Reflect.get.bind(null, obj)), null, [null, 'constructor'])",
    ],
    source:
      "return run.apply.bind(run.call.bind(Reflect.get.bind(null, obj)), null, [null, 'constructor'])()(text)();",
    what: 'an array `apply` is bound to that gives the key',
  },
  {
    reads: [
      "run.apply.call(run.call.bind(Reflect.get.bind(null, obj)), null, [null, 'constructor'])",
    ],
    source:
      "return run.apply.call(run.call.bind(Reflect.get.bind(null, obj)), null, [null, 'constructor'])(text)();",
    what: 'an array `apply` is called with that gives the key',
  },
  // An object of the code's own, whose `call`, `apply` and `bind` are its own: read as a function's, refused.
  {
    reads: ["helper.call.call(Reflect.get, null, obj, 'constructor')"],
    source: "return helper.call.call(Reflect.get, null, obj, 'constructor');",
    what: '`call` of an object that has its own, called, refused',
  },
  {
    reads: ["helper.apply.call(Reflect.get, null, [obj, 'constructor'])"],
    source: "return helper.apply.call(Reflect.get, null, [obj, 'constructor']);",
    what: '`apply` of an object that has its own, called, refused',
  },
  {
    reads: ["helper.bind.call(Reflect.get, null, obj, 'constructor')"],
    source: "return helper.bind.call(Reflect.get, null, obj, 'constructor');",
    what: '`bind` of an object that has its own, called, refused',
  },
  {
    reads: [],
    source: "return helper.call(Reflect.get, null, obj, 'constructor');",
    what: 'an object that has its own `call`, called',
  },
  {
    reads: ["helper.call.bind(Reflect.get)(null, obj, 'constructor')"],
    source: "return helper.call.bind(Reflect.get)(null, obj, 'constructor');",
    what: '`call` of an object that has its own, bound, refused',
  },
  {
    reads: ["({ call: () => 42 }).call.call(Reflect.get, null, obj, 'constructor')"],
    source: "return ({ call: () => 42 }).call.call(Reflect.get, null, obj, 'constructor');",
    what: '`call` of an object written in place that has its own, refused',
  },
  {
    reads: ["fn.call.call(Reflect.get, null, run, 'constructor')"],
    source: "return fn.call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: '`call` of a function the code is given, called on the reader',
  },
  // An object whose `call`, `apply` or `bind` may still be a function's own: inherited, or the method itself.
  {
    reads: ["({ __proto__: run }).call.call(Reflect.get, null, run, 'constructor')"],
    source: "return ({ __proto__: run }).call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'an object written in place that inherits from a function',
  },
  {
    reads: ["({ '__proto__': run }).call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "return ({ '__proto__': run }).call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'an object that inherits from a function, the key written as text',
  },
  {
    reads: ["({ __proto__: fn, other: 1 }).apply.call(Reflect.get, null, [run, 'constructor'])"],
    source:
      "return ({ __proto__: fn, other: 1 }).apply.call(Reflect.get, null, [run, 'constructor'])(text)();",
    what: 'an object that inherits from a function, beside another member, `apply`',
  },
  {
    reads: ["({ __proto__: run }).bind.call(Reflect.get, null, run, 'constructor')"],
    source:
      "return ({ __proto__: run }).bind.call(Reflect.get, null, run, 'constructor')()(text)();",
    what: 'an object that inherits from a function, `bind`',
  },
  {
    reads: ["inheriting.call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "const inheriting = { __proto__: run };\n  return inheriting.call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'a constant of an object that inherits from a function',
  },
  {
    reads: ["made.call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "const made = Object.create(run);\n  return made.call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'a constant of what `Object.create` made of a function',
  },
  {
    reads: ["held.call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "const held = {};\n  Object.setPrototypeOf(held, run);\n  return held.call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'a constant of an object whose prototype is set to a function',
  },
  {
    reads: ["held.call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "const held = {};\n  Reflect.setPrototypeOf(held, run);\n  return held.call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'a constant of an object whose prototype `Reflect.setPrototypeOf` sets',
  },
  {
    reads: ["held.call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "const held: any = {};\n  held.__proto__ = run;\n  return held.call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'a constant of an object whose `__proto__` is assigned a function',
  },
  {
    reads: ["held.call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "const held: any = {};\n  held.call = run.call;\n  return held.call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'a constant of an object whose `call` is assigned the method',
  },
  {
    reads: ["held.call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "const held = {};\n  Object.assign(held, { call: run.call });\n  return held.call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'a constant of an object that is handed on',
  },
  {
    reads: ["({ call: run.call }).call.call(Reflect.get, null, run, 'constructor')"],
    source: "return ({ call: run.call }).call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'an object whose own `call` is the method',
  },
  {
    reads: ["({ ...{ call: run.call } }).call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "return ({ ...{ call: run.call } }).call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'an object whose members a spread gives',
  },
  {
    reads: [
      "({ get call() { return run.call; } }).call.call(Reflect.get, null, run, 'constructor')",
    ],
    source:
      "return ({ get call() { return run.call; } }).call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'an object whose `call` is a getter',
  },
  {
    reads: [
      "({ __proto__: run, call: () => 42 }).call.call(Reflect.get, null, obj, 'constructor')",
    ],
    source:
      "return ({ __proto__: run, call: () => 42 }).call.call(Reflect.get, null, obj, 'constructor');",
    what: 'an object that inherits from a function, with a `call` of its own, refused',
  },
  {
    reads: ["({ call() { return 42; } }).call.call(Reflect.get, null, obj, 'constructor')"],
    source: "return ({ call() { return 42; } }).call.call(Reflect.get, null, obj, 'constructor');",
    what: 'an object written in place with a method `call`, refused',
  },
  {
    reads: [
      "({ ['call']: function () { return 42; } }).call.call(Reflect.get, null, obj, 'constructor')",
    ],
    source:
      "return ({ ['call']: function () { return 42; } }).call.call(Reflect.get, null, obj, 'constructor');",
    what: 'an object written in place with a computed `call`, refused',
  },
  {
    reads: ["({}).call.call(Reflect.get, null, obj, 'constructor')"],
    source: "return ({}).call.call(Reflect.get, null, obj, 'constructor');",
    what: 'an object written in place with no `call`, refused',
  },
  {
    reads: ["own.call.call(Reflect.get, null, obj, 'constructor')"],
    source:
      "const own = { call: () => 42 };\n  return own.call.call(Reflect.get, null, obj, 'constructor');",
    what: 'a constant of an object with a `call` of its own, refused',
  },
  {
    reads: ["none.call.call(Reflect.get, null, obj, 'constructor')"],
    source: "const none = {};\n  return none.call.call(Reflect.get, null, obj, 'constructor');",
    what: 'a constant of an object with no `call`, refused',
  },
  // A member an object writes again, or a later entry overrides: the last of them is the member.
  {
    reads: [
      "({ call() { return 42; }, ...{ call: Reflect.get.call } }).call.call(Reflect.get, null, run, 'constructor')",
    ],
    source:
      "return ({ call() { return 42; }, ...{ call: Reflect.get.call } }).call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'a method that a later spread of the method overrides',
  },
  {
    reads: [
      "({ call: () => 42, call: run.call }).call.call(Reflect.get, null, run, 'constructor')",
    ],
    source:
      "return ({ call: () => 42, call: run.call }).call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'a function that a later entry of the name overrides with the method',
  },
  {
    reads: [
      "({ call: () => 42, ['ca' + 'll']: run.call }).call.call(Reflect.get, null, run, 'constructor')",
    ],
    source:
      "return ({ call: () => 42, ['ca' + 'll']: run.call }).call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'a function that a later entry of a name it computes may override',
  },
  {
    reads: ["({ call() { return 42; }, ...obj }).call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "return ({ call() { return 42; }, ...obj }).call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'a method that a later spread of an object may override',
  },
  {
    reads: [
      "({ call: run.call, call: () => 42 }).call.call(Reflect.get, null, obj, 'constructor')",
    ],
    source:
      "return ({ call: run.call, call: () => 42 }).call.call(Reflect.get, null, obj, 'constructor');",
    what: 'the method that a later function of the name overrides, refused',
  },
  {
    reads: [
      "({ ...{ call: run.call }, call: () => 42 }).call.call(Reflect.get, null, obj, 'constructor')",
    ],
    source:
      "return ({ ...{ call: run.call }, call: () => 42 }).call.call(Reflect.get, null, obj, 'constructor');",
    what: 'the method of an earlier spread that a later function overrides, refused',
  },
  // A function an object writes for the member, however wrapped: read as a function's all the same.
  {
    reads: ["({ call: (() => 42) }).call.call(Reflect.get, null, obj, 'constructor')"],
    source: "return ({ call: (() => 42) }).call.call(Reflect.get, null, obj, 'constructor');",
    what: 'a function in parentheses, refused',
  },
  {
    reads: ["({ call: (0, () => 42) }).call.call(Reflect.get, null, obj, 'constructor')"],
    source: "return ({ call: (0, () => 42) }).call.call(Reflect.get, null, obj, 'constructor');",
    what: 'a function past a comma, refused',
  },
  {
    reads: ["({ call: <any>(() => 42) }).call.call(Reflect.get, null, obj, 'constructor')"],
    source: "return ({ call: <any>(() => 42) }).call.call(Reflect.get, null, obj, 'constructor');",
    what: 'a function in a cast in angle brackets, refused',
  },
  {
    reads: ["({ call: (() => 42) as any }).call.call(Reflect.get, null, obj, 'constructor')"],
    source:
      "return ({ call: (() => 42) as any }).call.call(Reflect.get, null, obj, 'constructor');",
    what: 'a function in a cast, refused',
  },
  {
    reads: [
      "({ call: ((() => 42) satisfies () => number)! }).call.call(Reflect.get, null, obj, 'constructor')",
    ],
    source:
      "return ({ call: ((() => 42) satisfies () => number)! }).call.call(Reflect.get, null, obj, 'constructor');",
    what: 'a function past `satisfies` and a non-null assertion, refused',
  },
  {
    reads: [
      "({ call: text ? () => 42 : () => 43 }).call.call(Reflect.get, null, obj, 'constructor')",
    ],
    source:
      "return ({ call: text ? () => 42 : () => 43 }).call.call(Reflect.get, null, obj, 'constructor');",
    what: 'a function either of two a condition gives, refused',
  },
  {
    reads: [
      "({ call: (() => 42) || (() => 43) }).call.call(Reflect.get, null, obj, 'constructor')",
    ],
    source:
      "return ({ call: (() => 42) || (() => 43) }).call.call(Reflect.get, null, obj, 'constructor');",
    what: 'a function either of two `||` gives, refused',
  },
  {
    reads: [
      "({ call: (() => 42) ?? (() => 43) }).call.call(Reflect.get, null, obj, 'constructor')",
    ],
    source:
      "return ({ call: (() => 42) ?? (() => 43) }).call.call(Reflect.get, null, obj, 'constructor');",
    what: 'a function either of two `??` gives, refused',
  },
  {
    reads: ["({ [(0, 'call')]: () => 42 }).call.call(Reflect.get, null, obj, 'constructor')"],
    source:
      "return ({ [(0, 'call')]: () => 42 }).call.call(Reflect.get, null, obj, 'constructor');",
    what: 'a function for a name written past a comma, refused',
  },
  {
    reads: ["({ [<any>'call']: () => 42 }).call.call(Reflect.get, null, obj, 'constructor')"],
    source:
      "return ({ [<any>'call']: () => 42 }).call.call(Reflect.get, null, obj, 'constructor');",
    what: 'a function for a name in a cast in angle brackets, refused',
  },
  {
    reads: ["({ call: (0, run.call) }).call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "return ({ call: (0, run.call) }).call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'the method past a comma',
  },
  {
    reads: ["({ call: <any>run.call }).call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "return ({ call: <any>run.call }).call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'the method in a cast in angle brackets',
  },
  {
    reads: ["({ call: (() => 42) && run.call }).call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "return ({ call: (() => 42) && run.call }).call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'the method a function and `&&` give',
  },
  {
    reads: ["({ call: run.call || (() => 42) }).call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "return ({ call: run.call || (() => 42) }).call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'the method or a function, `||`',
  },
  {
    reads: [
      "({ call: text ? () => 42 : run.call }).call.call(Reflect.get, null, run, 'constructor')",
    ],
    source:
      "return ({ call: text ? () => 42 : run.call }).call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'a function or the method, a condition gives',
  },
  {
    reads: ["({ [(0, 'call')]: run.call }).call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "return ({ [(0, 'call')]: run.call }).call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'the method for a name written past a comma',
  },
  // A constant read through what hands its value on, `(0, held).call`: read as a function's.
  {
    reads: ["(0, helper).call.call(Reflect.get, null, obj, 'constructor')"],
    source:
      "const helper = { call: () => 42 };\n  return (0, helper).call.call(Reflect.get, null, obj, 'constructor');",
    what: 'a constant read for a member past a comma, refused',
  },
  {
    reads: ["(<any>helper).call.call(Reflect.get, null, obj, 'constructor')"],
    source:
      "const helper = { call: () => 42 };\n  return (<any>helper).call.call(Reflect.get, null, obj, 'constructor');",
    what: 'a constant read for a member in a cast in angle brackets, refused',
  },
  {
    reads: ["((helper) as any).call.call(Reflect.get, null, obj, 'constructor')"],
    source:
      "const helper = { call: () => 42 };\n  return ((helper) as any).call.call(Reflect.get, null, obj, 'constructor');",
    what: 'a constant read for a member in a cast and parentheses, refused',
  },
  {
    reads: ["held.call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "const held: any = { call: () => 42 };\n  const copy = (0, held);\n  copy.call = run.call;\n  return held.call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'a constant handed on past a comma, and changed by what it was handed to',
  },
  {
    reads: ["held.call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "const held: any = { call: () => 42 };\n  const copy = text ? held : obj;\n  copy.call = run.call;\n  return held.call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'a constant handed on by a condition, and changed by what it was handed to',
  },
  {
    reads: ["held.call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "const held: any = { call: () => 42 };\n  const copy = held || obj;\n  copy.call = run.call;\n  return held.call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'a constant handed on by `||`, and changed by what it was handed to',
  },
  // A constant whose methods change what it is, or may: read as a function's, as any other is.
  {
    reads: ["helper.call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "const helper = { call() { return 42; }, setup() { Object.assign(this, { call: run.call }); } };\n  helper.setup();\n  return helper.call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'a constant whose method gives `this` the method',
  },
  {
    reads: ["helper.call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "const helper: any = { call() { return 42; }, setup() { this.call = run.call; } };\n  helper.setup();\n  return helper.call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'a constant whose method assigns `this` the method',
  },
  {
    reads: ["helper.call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "const helper = { call: () => 42, get touch() { Object.assign(this, { call: run.call }); return 1; } };\n  helper.touch;\n  return helper.call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'a constant whose getter gives `this` the method, read',
  },
  {
    reads: ["helper.call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "const base = { setup() { Object.assign(this, { call: run.call }); } };\n  const helper = { __proto__: base, call: () => 42 };\n  helper.setup();\n  return helper.call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'a constant that inherits a method that gives `this` the method',
  },
  {
    reads: ["helper.call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "const base = { get touch() { Object.assign(this, { call: run.call }); return 1; } };\n  const helper = { __proto__: base, call: () => 42 };\n  helper.touch;\n  return helper.call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'a constant that inherits a getter that gives `this` the method, read',
  },
  {
    reads: ["helper.call.call(Reflect.get, null, run, 'constructor')"],
    source:
      "const helper = { call: () => 42, setup: run.bind(null) };\n  helper.setup();\n  return helper.call.call(Reflect.get, null, run, 'constructor')(text)();",
    what: 'a constant whose member is called, which the code does not show',
  },
  {
    reads: ["helper.call.call(Reflect.get, null, obj, 'constructor')"],
    source:
      "const helper = { call: () => 42, other() { return 1; } };\n  helper.other();\n  return helper.call.call(Reflect.get, null, obj, 'constructor');",
    what: 'a constant whose own method, which gives `this` nothing, is called, refused',
  },
  {
    reads: ["helper.call.call(Reflect.get, null, obj, 'constructor')"],
    source:
      "const helper = { call: () => 42 };\n  helper.call(Reflect.get, null, obj, 'constructor');\n  return helper.call.call(Reflect.get, null, obj, 'constructor');",
    what: 'a constant whose own `call` is called, refused',
  },
  // Optional chains and wrappers.
  {
    reads: ["Reflect.get?.bind(null, run)?.('constructor')"],
    source: "return Reflect.get?.bind(null, run)?.('constructor')?.(text)?.();",
    what: 'a reader bound and called through optional chains',
  },
  {
    reads: ["Reflect?.get.call?.(null, run, 'constructor')"],
    source: "return Reflect?.get.call?.(null, run, 'constructor')(text)();",
    what: 'a reader borrowed through optional chains',
  },
  {
    reads: ["Reflect.apply((0, Reflect.get), null, [run, 'constructor'])"],
    source: "return Reflect.apply((0, Reflect.get), null, [run, 'constructor'])(text)();",
    what: 'a reader given to `Reflect.apply` past a comma',
  },
  {
    reads: ["(<any>Reflect.get.bind(null)).bind(null, run)('constructor')"],
    source: "return (<any>Reflect.get.bind(null)).bind(null, run)('constructor')(text)();",
    what: 'a bound reader in a cast in angle brackets, bound again',
  },
  {
    reads: ["(Reflect.get.bind(null) as any).bind(null, run)('constructor')"],
    source: "return (Reflect.get.bind(null) as any).bind(null, run)('constructor')(text)();",
    what: 'a bound reader in a cast, bound again',
  },
  // Other readers.
  {
    reads: ["Object.getOwnPropertyDescriptor.bind(Object).bind(null, run)('constructor')"],
    source: "return Object.getOwnPropertyDescriptor.bind(Object).bind(null, run)('constructor');",
    what: '`Object.getOwnPropertyDescriptor` bound twice',
  },
  {
    reads: [
      "Reflect.getOwnPropertyDescriptor.apply.bind(Reflect.getOwnPropertyDescriptor)(Reflect, [run, 'constructor'])",
    ],
    source:
      "return Reflect.getOwnPropertyDescriptor.apply.bind(Reflect.getOwnPropertyDescriptor)(Reflect, [run, 'constructor']);",
    what: '`Reflect.getOwnPropertyDescriptor`, `apply` bound to it',
  },
  // A key written before a spread reads; one past it is for the code to tell.
  {
    reads: ["Reflect.get(run, 'constructor', ...rest)"],
    source: "return Reflect.get(run, 'constructor', ...rest)(text)();",
    what: 'a key written before a spread, given directly',
  },
  {
    reads: ["Reflect.apply(Reflect.get, null, [run, 'constructor', ...rest])"],
    source: "return Reflect.apply(Reflect.get, null, [run, 'constructor', ...rest])(text)();",
    what: 'a key before a spread, in the array `Reflect.apply` is given',
  },
  // What is not a read.
  {
    reads: [],
    source: "return Reflect.get(...[run, 'name'] as const, 'constructor');",
    what: 'a key past the spread of an array, given directly',
  },
  {
    reads: ["Reflect.get(...rest, 'constructor')"],
    source: "return Reflect.get(...rest, 'constructor');",
    what: 'a key past a spread of a list given by a name, given directly',
  },
  {
    reads: ["Object.getOwnPropertyDescriptor(...args, 'constructor')"],
    source: "return Object.getOwnPropertyDescriptor(...args, 'constructor');",
    what: 'a key past a spread given to `Object.getOwnPropertyDescriptor`',
  },
  {
    reads: [],
    source: 'return Reflect.get(...args);',
    what: 'what a spread alone gives',
  },
  {
    reads: [],
    source: "return Reflect.get.bind(null).bind(null, run)('name');",
    what: 'another key, given to a reader bound twice',
  },
  {
    reads: [],
    source: "return Reflect.get.bind(null, run, 'name').bind(null)('constructor');",
    what: 'a key given after the one a bound reader already has',
  },
  {
    reads: ["Reflect.get.bind(null, run).bind(null, ...rest)('constructor')"],
    source: "return Reflect.get.bind(null, run).bind(null, ...rest)('constructor');",
    what: 'a key past a spread of what `bind` is given the second time',
  },
  {
    reads: ["Reflect.get.bind(null, ...rest).bind(null, run)('constructor')"],
    source: "return Reflect.get.bind(null, ...rest).bind(null, run)('constructor');",
    what: 'a key past a spread of what `bind` is given the first time',
  },
  {
    reads: [],
    source: 'return Reflect.get.bind(null).bind(null, run);',
    what: 'a reader bound twice, called not at all',
  },
  {
    reads: [],
    source: "return Reflect.get.bind(run, 'constructor').bind(null)();",
    what: "`'constructor'` as what is read, the `this` taken first, bound twice",
  },
  {
    reads: [],
    source: "return run.call.bind(Reflect.get)(null, run, 'name');",
    what: 'another key, given to `call` bound to the reader',
  },
  {
    reads: [],
    source: "return run.call.bind(Reflect.get)('constructor');",
    what: "`'constructor'` as the `this` `call` bound to the reader takes",
  },
  {
    reads: [],
    source: 'return run.apply.bind(Reflect.get)(null, args);',
    what: 'an array given to `apply` bound to the reader by a name',
  },
  {
    reads: [],
    source: "return run.call.call(Reflect.get, null, run, 'name');",
    what: 'another key, given to `call` called on the reader',
  },
  {
    reads: [],
    source: "return run.call.call(Reflect.get, 'constructor');",
    what: "`'constructor'` as the `this` of `call` called on the reader",
  },
  {
    reads: [],
    source: "return run.call.call(...args, null, run, 'constructor');",
    what: 'a function `call` is called on that a spread may be',
  },
  {
    reads: [],
    source: "return Reflect.apply(Reflect.get, null, [run, 'name']);",
    what: 'another key, given to `Reflect.apply`',
  },
  {
    reads: [],
    source: 'return Reflect.apply(Reflect.get, null, args);',
    what: 'an array given to `Reflect.apply` by a name',
  },
  {
    reads: ["Reflect.apply(Reflect.get, null, [...rest, 'constructor'])"],
    source: "return Reflect.apply(Reflect.get, null, [...rest, 'constructor']);",
    what: 'a key past a spread in the array `Reflect.apply` is given',
  },
  {
    reads: [],
    source: "return Reflect.apply(...args, null, [run, 'constructor']);",
    what: 'a function `Reflect.apply` is given by a spread',
  },
  {
    reads: [],
    source: "return Reflect.apply(Reflect.get, null, ['constructor', run]);",
    what: "`'constructor'` as what is read, the first given",
  },
  {
    reads: [],
    source: "return Reflect.apply(fn, null, [run, 'constructor']);",
    what: 'a function `Reflect.apply` is given that is not a reader',
  },
  {
    reads: [],
    source: "return reader.get.bind(null).bind(null, run)('constructor');",
    what: 'a function of the module, bound twice',
  },
  {
    reads: [],
    source: "return run.call.bind(reader.get)(null, run, 'constructor');",
    what: 'a function of the module, `call` bound to it',
  },
  {
    reads: [],
    source: "return run.call.call(reader.get, null, run, 'constructor');",
    what: 'a function of the module, `call` called on it',
  },
] as const;

describe('a key reader of the language called through call, apply, bind and Reflect.apply', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** The text of each node of the function `run`, whose body is `body`, that reads what made code. */
  function codeReadsIn(body: string): readonly string[] {
    const source = [
      'const reader = { get: (target: unknown, key: string) => key };',
      'const helper = { apply: () => 42, bind: () => 42, call: () => 42 };',
      'const obj = {};',
      'export function run(text: string, rest: unknown[], args: unknown[], fn: () => void): unknown {',
      `  ${body}`,
      '}',
      '',
    ].join('\n');
    using parsed = api.createSourceFile('chains.ts', source);
    const { sourceFile } = parsed;
    const reads: string[] = [];
    const visit = (node: Node): void => {
      if (isErased(node)) {
        return;
      }
      if (readsCodeGlobal(node)) {
        reads.push(source.slice(node.getStart(sourceFile), node.end));
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    return reads;
  }

  it.each(CASES)('reads $what', ({ reads, source }) => {
    expect(codeReadsIn(source)).toStrictEqual(reads);
  });
});
