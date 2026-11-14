import { describe, expect, it } from 'vitest';

import { prototypeMayChange } from '../src/compiler/framed-prototype-changes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A member of a native prototype is read, not called with the prototype as its `this`:
 * `Array.prototype.valueOf()` answers the prototype itself, which the code may then give to
 * `Object.defineProperty`, and `Array.prototype.push(fn)` writes it. Any direct call of such a
 * member (through a cast, parentheses, `?.()`, a tagged template or `new`, on `Array.prototype`,
 * `Object.prototype`, `Function.prototype`, a helper's `prototype` or the answer of
 * `getPrototypeOf`) is a use that may reach a prototype, the answer used or not. Through `call`,
 * `apply` and `bind` a member is called on what the code gives, and `valueOf` of a date or an array
 * is no prototype's.
 */
const CASES = [
  {
    id: 'array-prototype-value-of-given-away-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { const root = Array.prototype.valueOf(); Object.defineProperty(root, 'join', { get: () => 1, set() {} }); }`,
    changes: true,
  },
  {
    id: 'object-prototype-value-of-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void Object.prototype.valueOf(); }`,
    changes: true,
  },
  {
    id: 'function-prototype-value-of-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void Function.prototype.valueOf(); }`,
    changes: true,
  },
  {
    id: 'array-prototype-value-of-through-a-cast-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void (Array.prototype as any).valueOf(); }`,
    changes: true,
  },
  {
    id: 'array-prototype-value-of-in-parentheses-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void (Array.prototype.valueOf)(); }`,
    changes: true,
  },
  {
    id: 'array-prototype-value-of-through-a-cast-callee-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void (Array.prototype.valueOf as any)(); }`,
    changes: true,
  },
  {
    id: 'array-prototype-value-of-optional-call-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void (Array.prototype as any).valueOf?.(); }`,
    changes: true,
  },
  {
    id: 'array-prototype-value-of-tagged-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void (Array.prototype as any).valueOf\`\`; }`,
    changes: true,
  },
  {
    id: 'array-prototype-value-of-by-a-text-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void Array.prototype['valueOf'](); }`,
    changes: true,
  },
  {
    id: 'array-prototype-value-of-answer-unused-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { Array.prototype.valueOf(); }`,
    changes: true,
  },
  {
    id: 'array-prototype-method-called-with-it-as-this-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { Array.prototype.sort(); }`,
    changes: true,
  },
  {
    id: 'array-prototype-method-pushing-a-function-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { Array.prototype.push(fn); }`,
    changes: true,
  },
  {
    id: 'array-prototype-method-filling-it-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { Array.prototype.fill(fn); }`,
    changes: true,
  },
  {
    id: 'array-prototype-slice-answer-used-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void Array.prototype.slice(); }`,
    changes: true,
  },
  {
    id: 'prototype-answer-value-of-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void Object.getPrototypeOf(a).valueOf(); }`,
    changes: true,
  },
  {
    id: 'reflect-prototype-answer-value-of-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void Reflect.getPrototypeOf(a).valueOf(); }`,
    changes: true,
  },
  {
    id: 'prototype-answer-method-called-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void Object.getPrototypeOf(a).hasOwnProperty('join'); }`,
    changes: true,
  },
  {
    id: 'global-array-prototype-value-of-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void globalThis.Array.prototype.valueOf(); }`,
    changes: true,
  },
  {
    id: 'window-object-prototype-value-of-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void window.Object.prototype.valueOf(); }`,
    changes: true,
  },
  {
    id: 'helper-prototype-value-of-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void helper.prototype.valueOf(); }`,
    changes: true,
  },
  {
    id: 'array-prototype-value-of-with-the-prototype-as-argument-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void Array.prototype.valueOf.call(Array.prototype); }`,
    changes: true,
  },
  {
    id: 'array-prototype-value-of-new-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void new (Array.prototype.valueOf as any)(); }`,
    changes: true,
  },
  {
    id: 'array-prototype-value-of-called-on-an-array-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void Array.prototype.valueOf.call(a); }`,
    changes: false,
  },
  {
    id: 'array-prototype-join-called-on-an-array-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void Array.prototype.join.call(a); }`,
    changes: false,
  },
  {
    id: 'array-prototype-slice-applied-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void Array.prototype.slice.apply(a, [0]); }`,
    changes: false,
  },
  {
    id: 'array-prototype-join-bound-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void Array.prototype.join.bind(a); }`,
    changes: false,
  },
  {
    id: 'object-prototype-has-own-property-called-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void Object.prototype.hasOwnProperty.call(source, 'x'); }`,
    changes: false,
  },
  {
    id: 'array-prototype-value-of-read-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void Array.prototype.valueOf; }`,
    changes: false,
  },
  {
    id: 'date-value-of-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void date.valueOf(); }`,
    changes: false,
  },
  {
    id: 'array-value-of-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void a.valueOf(); }`,
    changes: false,
  },
  {
    id: 'helper-value-of-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void helper.valueOf(); }`,
    changes: false,
  },
  {
    id: 'new-date-value-of-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void new Date().valueOf(); }`,
    changes: false,
  },
  {
    id: 'prototype-answer-compared-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void (Object.getPrototypeOf(a) === Array.prototype); }`,
    changes: false,
  },
  {
    id: 'prototype-answer-member-read-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void (Object.getPrototypeOf(a) as any).join; }`,
    changes: false,
  },
] as const;

describe('a file that calls a member of a prototype with the prototype as its this', () => {
  it.each(CASES)('$id', ({ source, changes }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'prototype-dire.ts', source);

    expect(prototypeMayChange(parsed.sourceFile)).toBe(changes);
  });
});
