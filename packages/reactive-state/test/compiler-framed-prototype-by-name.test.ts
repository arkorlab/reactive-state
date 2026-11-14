import { describe, expect, it } from 'vitest';

import { prototypeMayChange } from '../src/compiler/framed-prototype-changes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A file may give an array another prototype, or another inherited method, where it mentions by
 * name what reaches one: `__proto__`, `constructor`, `prototype`, `getPrototypeOf`, `setPrototypeOf`,
 * `__defineGetter__`, `__defineSetter__`, `__lookupGetter__` and `__lookupSetter__`, as a member, a key
 * or a text of any object; or a global that holds one (`Object`, `Reflect`, `Array`, `Function`, the
 * global objects) used otherwise than as a type, a `typeof`, the right of an `instanceof`, a
 * construction of `Array` or `Object`, or a call by its name of `Array.from`, `isArray`, `of`,
 * `Object.assign`, `entries`, `freeze`, `fromEntries`, `keys` and `values`. Nothing more is read: not
 * what a call answers, not a name made at run time, and a holder the module declares is no holder.
 */
const HEAD =
  'function frames(error: Error, name: string, p: object, helper: any, use: (value: unknown) => unknown) { const a: unknown[] = [error];';

const CASES = [
  {
    id: 'proto-member-written-refused',
    source: `${HEAD} a.__proto__ = p; return a; }`,
    changes: true,
  },
  {
    id: 'proto-key-written-as-text-refused',
    source: `${HEAD} (a as any)['__proto__'] = p; return a; }`,
    changes: true,
  },
  {
    id: 'proto-key-of-a-literal-refused',
    source: `${HEAD} void { __proto__: p }; return a; }`,
    changes: true,
  },
  {
    id: 'set-prototype-of-called-refused',
    source: `${HEAD} Object.setPrototypeOf(a, p); return a; }`,
    changes: true,
  },
  {
    id: 'set-prototype-of-of-a-helper-refused',
    source: `${HEAD} helper.setPrototypeOf(a, p); return a; }`,
    changes: true,
  },
  {
    id: 'define-setter-called-refused',
    source: `${HEAD} (a as any).__defineSetter__('join', () => 1); return a; }`,
    changes: true,
  },
  {
    id: 'constructor-prototype-read-refused',
    source: `${HEAD} void (a as any).constructor.prototype; return a; }`,
    changes: true,
  },
  {
    id: 'prototype-of-the-arrays-read-refused',
    source: `${HEAD} void Array.prototype.join; return a; }`,
    changes: true,
  },
  {
    id: 'prototype-member-called-on-an-array-refused',
    source: `${HEAD} void Array.prototype.slice.call(a); return a; }`,
    changes: true,
  },
  {
    id: 'object-prototype-member-called-on-an-array-refused',
    source: `${HEAD} void Object.prototype.hasOwnProperty.call(a, 'x'); return a; }`,
    changes: true,
  },
  {
    id: 'constructor-compared-to-array-refused',
    source: `${HEAD} void (a.constructor === Array); return a; }`,
    changes: true,
  },
  {
    id: 'constructor-name-read-refused',
    source: `${HEAD} void a.constructor.name; return a; }`,
    changes: true,
  },
  {
    id: 'get-prototype-of-compared-refused',
    source: `${HEAD} void (Object.getPrototypeOf(a) === Array.prototype); return a; }`,
    changes: true,
  },
  {
    id: 'get-prototype-of-called-refused',
    source: `${HEAD} void Reflect.getPrototypeOf(a); return a; }`,
    changes: true,
  },
  {
    id: 'define-property-called-refused',
    source: `${HEAD} Object.defineProperty(a, 'x', { value: 1 }); return a; }`,
    changes: true,
  },
  {
    id: 'define-properties-called-refused',
    source: `${HEAD} Object.defineProperties(a, {}); return a; }`,
    changes: true,
  },
  {
    id: 'reflect-define-property-called-refused',
    source: `${HEAD} Reflect.defineProperty(a, 'x', { value: 1 }); return a; }`,
    changes: true,
  },
  {
    id: 'reflect-set-called-refused',
    source: `${HEAD} Reflect.set(a, 'x', 1); return a; }`,
    changes: true,
  },
  {
    id: 'reflect-apply-called-refused',
    source: `${HEAD} Reflect.apply(use, null, [a]); return a; }`,
    changes: true,
  },
  {
    id: 'reflect-has-called-refused',
    source: `${HEAD} void Reflect.has(a, 0); return a; }`,
    changes: true,
  },
  {
    id: 'reflect-own-keys-called-refused',
    source: `${HEAD} void Reflect.ownKeys(a); return a; }`,
    changes: true,
  },
  {
    id: 'get-own-property-names-called-refused',
    source: `${HEAD} void Object.getOwnPropertyNames(a); return a; }`,
    changes: true,
  },
  {
    id: 'is-frozen-called-refused',
    source: `${HEAD} void Object.isFrozen(a); return a; }`,
    changes: true,
  },
  {
    id: 'object-is-called-refused',
    source: `${HEAD} void Object.is(a, a); return a; }`,
    changes: true,
  },
  {
    id: 'class-extending-array-refused',
    source: `${HEAD} class Rows extends Array {} void Rows; return a; }`,
    changes: true,
  },
  {
    id: 'class-extending-object-refused',
    source: `${HEAD} class Table extends Object {} void Table; return a; }`,
    changes: true,
  },
  {
    id: 'holder-compared-refused',
    source: `${HEAD} void (use === Object); return a; }`,
    changes: true,
  },
  {
    id: 'holder-in-a-variable-refused',
    source: `${HEAD} const holder = Object; void holder; return a; }`,
    changes: true,
  },
  {
    id: 'holder-given-to-a-call-refused',
    source: `${HEAD} use(Reflect); return a; }`,
    changes: true,
  },
  {
    id: 'member-of-the-global-object-called-refused',
    source: `${HEAD} void globalThis.Object.keys(a); return a; }`,
    changes: true,
  },
  {
    id: 'member-of-a-holder-by-a-key-the-code-computes-refused',
    source: `${HEAD} void (Object as any)[name](a); return a; }`,
    changes: true,
  },
  {
    id: 'member-of-a-holder-written-refused',
    source: `${HEAD} (Object as any).keys = () => []; return a; }`,
    changes: true,
  },
  {
    id: 'assign-held-as-a-function-refused',
    source: `${HEAD} const assign = Object.assign; assign(a, {}); return a; }`,
    changes: true,
  },
  {
    id: 'assign-borrowed-through-call-refused',
    source: `${HEAD} Object.assign.call(null, a, {}); return a; }`,
    changes: true,
  },
  {
    id: 'name-read-by-a-type-pin',
    source: `${HEAD} const list: Array<string> = []; type Table = typeof Object; void list; return a; }`,
    changes: false,
  },
  {
    id: 'typeof-a-holder-pin',
    source: `${HEAD} void (typeof Object); return a; }`,
    changes: false,
  },
  {
    id: 'instanceof-array-pin',
    source: `${HEAD} void (a instanceof Array); return a; }`,
    changes: false,
  },
  {
    id: 'instanceof-object-pin',
    source: `${HEAD} void (use instanceof Object); return a; }`,
    changes: false,
  },
  {
    id: 'new-array-pin',
    source: `${HEAD} void new Array(3); return a; }`,
    changes: false,
  },
  {
    id: 'array-called-pin',
    source: `${HEAD} void Array(3); return a; }`,
    changes: false,
  },
  {
    id: 'new-object-pin',
    source: `${HEAD} void new Object(); return a; }`,
    changes: false,
  },
  {
    id: 'array-from-pin',
    source: `${HEAD} void Array.from(a); return a; }`,
    changes: false,
  },
  {
    id: 'array-is-array-pin',
    source: `${HEAD} void Array.isArray(a); return a; }`,
    changes: false,
  },
  {
    id: 'array-of-pin',
    source: `${HEAD} void Array.of(1); return a; }`,
    changes: false,
  },
  {
    id: 'object-keys-pin',
    source: `${HEAD} void Object.keys(a); return a; }`,
    changes: false,
  },
  {
    id: 'object-values-pin',
    source: `${HEAD} void Object.values(a); return a; }`,
    changes: false,
  },
  {
    id: 'object-entries-pin',
    source: `${HEAD} void Object.entries(a); return a; }`,
    changes: false,
  },
  {
    id: 'object-from-entries-pin',
    source: `${HEAD} void Object.fromEntries([]); return a; }`,
    changes: false,
  },
  {
    id: 'object-freeze-pin',
    source: `${HEAD} void Object.freeze(a); return a; }`,
    changes: false,
  },
  {
    id: 'object-assign-of-a-new-object-pin',
    source: `${HEAD} void Object.assign({}, a); return a; }`,
    changes: false,
  },
  {
    id: 'member-of-a-plain-object-by-a-computed-key-pin',
    source: `${HEAD} void (p as any)[name]; return a; }`,
    changes: false,
  },
  {
    id: 'method-of-an-array-by-its-name-pin',
    source: `${HEAD} void a.map((each) => each); return a; }`,
    changes: false,
  },
  {
    id: 'member-of-an-array-by-a-text-pin',
    source: `${HEAD} void a['join']; return a; }`,
    changes: false,
  },
  {
    id: 'holder-the-module-declares-pin',
    source: `${HEAD} const Object = { keys: () => [] as string[] }; void Object.keys(); return a; }`,
    changes: false,
  },
  {
    id: 'parameter-named-like-a-holder-pin',
    source: `${HEAD} function inner(Array: { from: () => number }) { return Array.from(); } void inner; return a; }`,
    changes: false,
  },
] as const;

describe('a file that mentions by name what reaches a prototype', () => {
  it.each(CASES)('$id', ({ source, changes }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'prototype-by-name.ts', source);

    expect(prototypeMayChange(parsed.sourceFile)).toBe(changes);
  });
});
