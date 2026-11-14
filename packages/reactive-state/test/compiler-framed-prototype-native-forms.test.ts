import { describe, expect, it } from 'vitest';

import { prototypeMayChange } from '../src/compiler/framed-prototype-changes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A file may give an array another inherited method wherever it reaches the prototype of the arrays
 * (or of the objects and the functions), however it names it: `Array.prototype`, `Array['prototype']`, a
 * template or a computed key on `Array`, an alias or a destructuring of `Array`, `Reflect.get(Array,
 * 'prototype')`, `Object.getPrototypeOf(a)`, `a.constructor.prototype`, a name that is given to code or
 * has a member written or deleted. A read of a member of it, a comparison, a type, `new Array`,
 * `x instanceof Array` and `Array.from` do not.
 */
const CASES = [
  {
    id: 'define-by-a-bracket-prototype',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Object.defineProperty(Array['prototype'], 'join', { set(value: unknown) {} }); }`,
    changes: true,
  },
  {
    id: 'define-properties-by-a-bracket-prototype',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Object.defineProperties(Array['prototype'], { join: { set(value: unknown) {} } }); }`,
    changes: true,
  },
  {
    id: 'assign-by-a-bracket-prototype',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Object.assign(Array['prototype'], { set join(value: unknown) {} }); }`,
    changes: true,
  },
  {
    id: 'assignment-to-a-member-of-a-bracket-prototype',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { (Array['prototype'] as any).join = () => 'x'; }`,
    changes: true,
  },
  {
    id: 'assignment-by-a-bracket-name-to-a-member-of-a-bracket-prototype',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { (Array['prototype'] as any)['join'] = () => 'x'; }`,
    changes: true,
  },
  {
    id: 'deletion-from-a-bracket-prototype',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { delete (Array['prototype'] as any).join; }`,
    changes: true,
  },
  {
    id: 'bracket-prototype-given-to-a-call',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { use(Array['prototype']); }`,
    changes: true,
  },
  {
    id: 'bracket-prototype-kept-in-a-variable',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { const proto = Array['prototype']; }`,
    changes: true,
  },
  {
    id: 'bracket-prototype-by-a-template',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Object.defineProperty(Array[\`prototype\`], 'join', { set(value: unknown) {} }); }`,
    changes: true,
  },
  {
    id: 'object-bracket-prototype',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Object.defineProperty(Object['prototype'], 'join', { set(value: unknown) {} }); }`,
    changes: true,
  },
  {
    id: 'function-bracket-prototype',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Object.defineProperty(Function['prototype'], 'call', { set(value: unknown) {} }); }`,
    changes: true,
  },
  {
    id: 'global-bracket-prototype',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Object.defineProperty(globalThis['Array']['prototype'], 'join', { set(value: unknown) {} }); }`,
    changes: true,
  },
  {
    id: 'global-array-bracket-prototype',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Object.defineProperty(globalThis.Array['prototype'], 'join', { set(value: unknown) {} }); }`,
    changes: true,
  },
  {
    id: 'prototype-by-a-computed-key',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Object.defineProperty(Array[key], 'join', { set(value: unknown) {} }); }`,
    changes: true,
  },
  {
    id: 'prototype-by-a-concatenated-key',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Object.defineProperty(Array['proto' + 'type'], 'join', { set(value: unknown) {} }); }`,
    changes: true,
  },
  {
    id: 'member-of-the-array-constructor-by-a-computed-key-written',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { (Array as any)[key].join = () => 'x'; }`,
    changes: true,
  },
  {
    id: 'prototype-by-property-access-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Object.defineProperty(Array.prototype, 'join', { set(value: unknown) {} }); }`,
    changes: true,
  },
  {
    id: 'read-of-a-bracket-prototype-member-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Array['prototype']['join']; }`,
    changes: false,
  },
  {
    id: 'call-of-a-bracket-prototype-member-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Array['prototype'].join.call(a); }`,
    changes: false,
  },
  {
    id: 'read-of-another-member-of-the-array-constructor-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Array['isArray'](a); }`,
    changes: false,
  },
  {
    id: 'read-of-the-prototype-of-a-class-refused-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { class Table {} void Table['prototype']; }`,
    changes: true,
  },
  {
    id: 'alias-of-the-array-constructor',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { const A = Array; (A.prototype as any).join = () => 'x'; }`,
    changes: true,
  },
  {
    id: 'reflect-get-of-the-prototype',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { (Reflect.get(Array, 'prototype') as any).join = () => 'x'; }`,
    changes: true,
  },
  {
    id: 'descriptor-of-the-prototype',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Object.defineProperty(Object.getOwnPropertyDescriptor(Array, 'prototype')!.value, 'join', { set(value: unknown) {} }); }`,
    changes: true,
  },
  {
    id: 'array-constructor-given-to-a-call',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { use(Array); }`,
    changes: true,
  },
  {
    id: 'function-constructor-given-to-a-call',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { use(Function); }`,
    changes: true,
  },
  {
    id: 'destructured-prototype',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { const { prototype } = Array; }`,
    changes: true,
  },
  {
    id: 'destructured-prototype-by-a-computed-key',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { const { [key]: proto } = Array; }`,
    changes: true,
  },
  {
    id: 'get-prototype-of-given-to-a-call',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Object.defineProperty(Object.getPrototypeOf(a), 'join', { set(value: unknown) {} }); }`,
    changes: true,
  },
  {
    id: 'constructor-prototype-given-to-a-call',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Object.defineProperty(a.constructor.prototype, 'join', { set(value: unknown) {} }); }`,
    changes: true,
  },
  {
    id: 'constructor-bracket-prototype-given-to-a-call',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Object.defineProperty(a['constructor']['prototype'], 'join', { set(value: unknown) {} }); }`,
    changes: true,
  },
  {
    id: 'window-array-prototype',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { Object.defineProperty(window.Array.prototype, 'join', { set(value: unknown) {} }); }`,
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
    id: 'array-of-a-type-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { const rows: Array<string> = []; void rows; }`,
    changes: false,
  },
  {
    id: 'array-of-a-cast-type-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void (a as Array<unknown>); }`,
    changes: false,
  },
  {
    id: 'array-comparison-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void (a.constructor === Array); }`,
    changes: false,
  },
  {
    id: 'array-instanceof-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void (a instanceof Array); }`,
    changes: false,
  },
  {
    id: 'array-new-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void new Array(3); }`,
    changes: false,
  },
  {
    id: 'array-extends-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { class Rows extends Array {} void Rows; }`,
    changes: false,
  },
  {
    id: 'function-new-refused-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void new Function('return 1'); }`,
    changes: true,
  },
  {
    id: 'get-prototype-of-compared-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void (Object.getPrototypeOf(a) === Object.prototype); }`,
    changes: false,
  },
  {
    id: 'get-prototype-of-read-of-a-member-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void Object.getPrototypeOf(a).join; }`,
    changes: false,
  },
  {
    id: 'constructor-prototype-read-of-a-member-refused-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void a.constructor.prototype.join; }`,
    changes: true,
  },
  {
    id: 'array-prototype-read-by-a-bracket-in-a-compare-pin',
    source: `function frames(a: unknown[], name: string, key: string, p: object) { void (Array['prototype'] === Object.getPrototypeOf(a)); }`,
    changes: false,
  },
] as const;

describe('a file that reaches the prototype of the arrays', () => {
  it.each(CASES)('$id', ({ source, changes }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-prototype-forms.ts', source);

    expect(prototypeMayChange(parsed.sourceFile)).toBe(changes);
  });
});
