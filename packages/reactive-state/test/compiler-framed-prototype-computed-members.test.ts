import { describe, expect, it } from 'vitest';

import { prototypeMayChange } from '../src/compiler/framed-prototype-changes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A member of a native prototype, read by the name the code writes (`Array.prototype.join`,
 * `Array.prototype['join']`) or by a key it computes (a number, a constant, a joined text, a name in a
 * variable), is a use that may reach a prototype: the file names `prototype`, and what a computed key
 * reads may be `__defineSetter__`, `constructor` or `__proto__`, a method that gives one a setter, called
 * with the prototype as its `this`.
 */
const CASES = [
  {
    id: 'array-prototype-read-by-a-runtime-key-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void Array.prototype[key]; }`,
    changes: true,
  },
  {
    id: 'array-prototype-method-called-by-a-runtime-key-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { (Array.prototype as any)[key]('join', fn); }`,
    changes: true,
  },
  {
    id: 'object-prototype-method-called-by-a-runtime-key-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { (Object.prototype as any)[key].call(a, 'join', fn); }`,
    changes: true,
  },
  {
    id: 'function-prototype-read-by-a-runtime-key-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void (Function.prototype as any)[key]; }`,
    changes: true,
  },
  {
    id: 'array-prototype-read-by-a-number-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void (Array.prototype as any)[0]; }`,
    changes: true,
  },
  {
    id: 'array-prototype-read-by-a-constant-key-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { const name = 'join'; void (Array.prototype as any)[name]; }`,
    changes: true,
  },
  {
    id: 'array-prototype-read-by-a-joined-key-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void (Array.prototype as any)['jo' + 'in']; }`,
    changes: true,
  },
  {
    id: 'array-prototype-read-by-a-key-in-parentheses-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void (Array.prototype as any)[(key)]; }`,
    changes: true,
  },
  {
    id: 'array-prototype-read-by-a-cast-key-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void (Array.prototype as any)[key as string]; }`,
    changes: true,
  },
  {
    id: 'array-prototype-read-by-an-optional-key-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void (Array.prototype as any)?.[key]; }`,
    changes: true,
  },
  {
    id: 'global-array-prototype-read-by-a-runtime-key-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void (globalThis.Array.prototype as any)[key]; }`,
    changes: true,
  },
  {
    id: 'window-array-prototype-read-by-a-runtime-key-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void (window.Array.prototype as any)[key]; }`,
    changes: true,
  },
  {
    id: 'prototype-of-a-helper-read-by-a-runtime-key-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void helper.prototype[key]; }`,
    changes: true,
  },
  {
    id: 'prototype-given-away-by-a-runtime-key-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { Object.defineProperty((Array.prototype as any)[key], 'x', { value: 1 }); }`,
    changes: true,
  },
  {
    id: 'prototype-answer-read-by-a-runtime-key-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void (Object.getPrototypeOf(a) as any)[key]; }`,
    changes: true,
  },
  {
    id: 'prototype-answer-called-by-a-runtime-key-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { (Object.getPrototypeOf(a) as any)[key]('join', fn); }`,
    changes: true,
  },
  {
    id: 'reflect-prototype-answer-read-by-a-runtime-key-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void (Reflect.getPrototypeOf(a) as any)[key]; }`,
    changes: true,
  },
  {
    id: 'prototype-answer-read-by-a-number-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void (Object.getPrototypeOf(a) as any)[0]; }`,
    changes: true,
  },
  {
    id: 'constructor-prototype-read-by-a-runtime-key-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void (a.constructor.prototype as any)[key]; }`,
    changes: true,
  },
  {
    id: 'array-prototype-written-by-a-runtime-key-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { (Array.prototype as any)[key] = fn; }`,
    changes: true,
  },
  {
    id: 'array-prototype-member-by-a-text-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void Array.prototype['join']; }`,
    changes: true,
  },
  {
    id: 'array-prototype-member-by-a-plain-template-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void Array.prototype[\`join\`]; }`,
    changes: true,
  },
  {
    id: 'array-prototype-member-by-a-name-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void Array.prototype.join; }`,
    changes: true,
  },
  {
    id: 'array-prototype-member-by-a-text-in-parentheses-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void Array.prototype[('join')]; }`,
    changes: true,
  },
  {
    id: 'object-prototype-member-by-a-text-called-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void Object.prototype['hasOwnProperty'].call(a, 'x'); }`,
    changes: true,
  },
  {
    id: 'prototype-answer-member-by-a-text-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void (Object.getPrototypeOf(a) as any)['join']; }`,
    changes: true,
  },
  {
    id: 'prototype-answer-compared-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void (Object.getPrototypeOf(a) === Array.prototype); }`,
    changes: true,
  },
  {
    id: 'array-element-by-a-runtime-key-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void a[key]; }`,
    changes: false,
  },
  {
    id: 'helper-member-by-a-runtime-key-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void helper[key]; }`,
    changes: false,
  },
  {
    id: 'member-of-a-called-prototype-member-by-a-runtime-key-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void) { void Array.prototype.join.call(a)[key]; }`,
    changes: true,
  },
] as const;

describe('a file that reads a member of a prototype by a key the code computes', () => {
  it.each(CASES)('$id', ({ source, changes }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'prototype-computed-members.ts', source);

    expect(prototypeMayChange(parsed.sourceFile)).toBe(changes);
  });
});
