import { describe, expect, it } from 'vitest';

import { prototypeMayChange } from '../src/compiler/framed-prototype-changes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A file may give an array another prototype, or another inherited method, unless every mention of
 * what reaches a prototype is one of a short list of uses that reach none. The list: a name read by a
 * type; `Array.from`, `Array.isArray`, `Array.of`, `new Array`, `instanceof Array`, `extends Array` (and
 * `Object` as a constructor); a call, by its name, of `Object.keys`, `values`, `entries`, `fromEntries`,
 * `freeze`, `isFrozen`, `getOwnPropertyNames`, `is`, `Reflect.has`, `ownKeys`; the functions that write
 * an object (`Object.assign`, `defineProperty`, `defineProperties`, `Reflect.apply`, `defineProperty`,
 * `set`), called or held; `getPrototypeOf` called, its answer compared or its member read; a member of
 * `Array.prototype`, `Object.prototype` or `Function.prototype` read by its name; a comparison of a
 * constructor or its `name`. Any other mention is a change: a key the code computes, a member the code
 * writes on a holder, a holder in a variable, a list, an object, an argument or the `this` of a call.
 */
const CASES = [
  {
    id: 'computed-key-that-is-prototype-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { const k = 'prototype'; Object.defineProperty(Array[k], 'join', { set(value: unknown) {} }); }`,
    changes: true,
  },
  {
    id: 'computed-key-of-a-constant-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { const k = 'keys'; Object[k](a); }`,
    changes: true,
  },
  {
    id: 'computed-key-on-reflect-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Reflect[key](a, 0); }`,
    changes: true,
  },
  {
    id: 'computed-key-on-the-global-object-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { globalThis[key]; }`,
    changes: true,
  },
  {
    id: 'user-reader-stored-on-object-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { (Object as any).reader = function (this: any, k: string) { return this[k]; }; const change = (Object as any).reader.call(Object, key); change(a, {}); }`,
    changes: true,
  },
  {
    id: 'user-member-of-object-called-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { (Object as any).helper(a); }`,
    changes: true,
  },
  {
    id: 'user-member-of-object-written-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { (Object as any).helper = 1; }`,
    changes: true,
  },
  {
    id: 'user-member-of-reflect-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { (Reflect as any).helper(a); }`,
    changes: true,
  },
  {
    id: 'user-member-of-array-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { (Array as any).custom(a); }`,
    changes: true,
  },
  {
    id: 'user-function-called-with-object-as-this-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { function reader(this: any, k: string) { return this[k]; } reader.call(Object, key); }`,
    changes: true,
  },
  {
    id: 'object-create-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Object.create(null); }`,
    changes: true,
  },
  {
    id: 'object-get-own-property-descriptor-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Object.getOwnPropertyDescriptor(a, 'x'); }`,
    changes: true,
  },
  {
    id: 'object-keys-held-as-a-value-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void [a].map(Object.keys); }`,
    changes: true,
  },
  {
    id: 'object-given-to-a-call-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { use(Object); }`,
    changes: true,
  },
  {
    id: 'array-in-a-variable-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { const A = Array; void A; }`,
    changes: true,
  },
  {
    id: 'array-in-a-list-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void [Array]; }`,
    changes: true,
  },
  {
    id: 'array-in-an-object-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void { A: Array }; }`,
    changes: true,
  },
  {
    id: 'object-with-a-this-argument-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Object.assign.call(Object, a, {}); }`,
    changes: true,
  },
  {
    id: 'global-object-member-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void globalThis.fetch; }`,
    changes: true,
  },
  {
    id: 'window-member-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void window.location; }`,
    changes: true,
  },
  {
    id: 'set-prototype-of-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Object.setPrototypeOf(a, p); }`,
    changes: true,
  },
  {
    id: 'reflect-set-prototype-of-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Reflect.setPrototypeOf(a, p); }`,
    changes: true,
  },
  {
    id: 'proto-write-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { (a as any).__proto__ = p; }`,
    changes: true,
  },
  {
    id: 'proto-text-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void a['__proto__']; }`,
    changes: true,
  },
  {
    id: 'prototype-written-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { (Array.prototype as any).join = () => 'x'; }`,
    changes: true,
  },
  {
    id: 'prototype-given-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { use(Array.prototype); }`,
    changes: true,
  },
  {
    id: 'prototype-kept-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { const proto = Array.prototype; void proto; }`,
    changes: true,
  },
  {
    id: 'prototype-of-a-class-written-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { class Table {} (Table.prototype as any).m = () => 1; }`,
    changes: true,
  },
  {
    id: 'constructor-given-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void a.constructor; }`,
    changes: true,
  },
  {
    id: 'constructor-prototype-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void a.constructor.prototype.join; }`,
    changes: true,
  },
  {
    id: 'constructor-destructured-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { const { constructor } = a; void constructor; }`,
    changes: true,
  },
  {
    id: 'prototype-destructured-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { const { prototype } = Function; void prototype; }`,
    changes: true,
  },
  {
    id: 'get-prototype-of-kept-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { const proto = Object.getPrototypeOf(a); void proto; }`,
    changes: true,
  },
  {
    id: 'get-prototype-of-given-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { use(Reflect.getPrototypeOf(a)); }`,
    changes: true,
  },
  {
    id: 'new-function-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void new Function('return 1'); }`,
    changes: true,
  },
  {
    id: 'array-from-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Array.from(a); }`,
    changes: false,
  },
  {
    id: 'array-is-array-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Array.isArray(a); }`,
    changes: false,
  },
  {
    id: 'array-of-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Array.of(1); }`,
    changes: false,
  },
  {
    id: 'new-array-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void new Array(3); }`,
    changes: false,
  },
  {
    id: 'array-called-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Array(3); }`,
    changes: false,
  },
  {
    id: 'instanceof-array-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void (a instanceof Array); }`,
    changes: false,
  },
  {
    id: 'extends-array-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { class Rows extends Array {} void Rows; }`,
    changes: false,
  },
  {
    id: 'extends-object-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { class Table extends Object {} void Table; }`,
    changes: false,
  },
  {
    id: 'type-names-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { const rows: Array<string> = []; const table: Record<string, Object> = {}; void rows; void table; }`,
    changes: false,
  },
  {
    id: 'typeof-object-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void typeof Object; }`,
    changes: false,
  },
  {
    id: 'object-keys-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Object.keys(a); }`,
    changes: false,
  },
  {
    id: 'object-values-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Object.values(a); }`,
    changes: false,
  },
  {
    id: 'object-entries-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Object.entries(a); }`,
    changes: false,
  },
  {
    id: 'object-from-entries-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Object.fromEntries([]); }`,
    changes: false,
  },
  {
    id: 'object-freeze-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Object.freeze(a); }`,
    changes: false,
  },
  {
    id: 'object-is-frozen-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Object.isFrozen(a); }`,
    changes: false,
  },
  {
    id: 'object-get-own-property-names-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Object.getOwnPropertyNames(a); }`,
    changes: false,
  },
  {
    id: 'object-is-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Object.is(a, a); }`,
    changes: false,
  },
  {
    id: 'object-keys-by-a-text-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Object['keys'](a); }`,
    changes: false,
  },
  {
    id: 'object-keys-of-the-global-object-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void globalThis.Object.keys(a); }`,
    changes: false,
  },
  {
    id: 'array-from-of-the-window-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void window.Array.from(a); }`,
    changes: false,
  },
  {
    id: 'reflect-has-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Reflect.has(a, 0); }`,
    changes: false,
  },
  {
    id: 'reflect-own-keys-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Reflect.ownKeys(a); }`,
    changes: false,
  },
  {
    id: 'object-assign-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Object.assign(a, {}); }`,
    changes: false,
  },
  {
    id: 'object-define-property-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Object.defineProperty(a, 'x', { value: 1 }); }`,
    changes: false,
  },
  {
    id: 'object-define-properties-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Object.defineProperties(a, {}); }`,
    changes: false,
  },
  {
    id: 'reflect-define-property-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Reflect.defineProperty(a, 'x', { value: 1 }); }`,
    changes: false,
  },
  {
    id: 'reflect-apply-of-assign-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Reflect.apply(Object.assign, null, [a, {}]); }`,
    changes: false,
  },
  {
    id: 'assign-held-as-a-function-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { const assign = Object.assign; assign(a, {}); }`,
    changes: false,
  },
  {
    id: 'assign-bound-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { const assign = Object.assign.bind(null); assign(a, {}); }`,
    changes: false,
  },
  {
    id: 'assign-called-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Object.assign.call(null, a, {}); }`,
    changes: false,
  },
  {
    id: 'assign-through-a-function-method-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Function.prototype.call.call(Object.assign, null, a, {}); }`,
    changes: false,
  },
  {
    id: 'get-prototype-of-compared-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void (Object.getPrototypeOf(a) === Array.prototype); }`,
    changes: false,
  },
  {
    id: 'get-prototype-of-answer-constructor-refused',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Reflect.getPrototypeOf(a)!.constructor; }`,
    changes: true,
  },
  {
    id: 'prototype-member-read-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Array.prototype.join.call(a); }`,
    changes: false,
  },
  {
    id: 'prototype-member-read-by-a-text-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Array['prototype']['join']; }`,
    changes: false,
  },
  {
    id: 'function-prototype-member-read-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Function.prototype.call; }`,
    changes: false,
  },
  {
    id: 'object-prototype-member-read-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Object.prototype.hasOwnProperty.call(a, 'x'); }`,
    changes: false,
  },
  {
    id: 'constructor-compared-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void (a.constructor === Array); }`,
    changes: false,
  },
  {
    id: 'constructor-name-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void a.constructor.name; }`,
    changes: false,
  },
  {
    id: 'class-constructor-declaration-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { class Table { constructor(public x: number) {} } void Table; }`,
    changes: false,
  },
  {
    id: 'fields-named-prototype-and-constructor-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void { prototype: 1, constructor: 2 }; }`,
    changes: false,
  },
  {
    id: 'no-mention-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void a.length; }`,
    changes: false,
  },
] as const;

describe('a file whose mentions of what reaches a prototype are read against a list of uses', () => {
  it.each(CASES)('$id', ({ source, changes }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'prototype-allowlist.ts', source);

    expect(prototypeMayChange(parsed.sourceFile)).toBe(changes);
  });
});
