import { describe, expect, it } from 'vitest';

import { prototypeMayChange } from '../src/compiler/framed-prototype-changes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A holder (`Object`, `Array`, `Reflect`, a global object, a constructor) may be tested by `typeof`
 * and as the right of an `instanceof`, not handed on. The right of an `instanceof` is read for its
 * `Symbol.hasInstance` and given the left: a holder on the left is given to the hook the right holds,
 * so it is a use that may reach a prototype, and so is a holder in a comparison. `typeof` takes no
 * part in it, of a global object (`typeof window`) as of any holder.
 */
const CASES = [
  {
    id: 'holder-on-the-left-of-an-instanceof-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { class Hook { static [Symbol.hasInstance](value: unknown) { return value === Array; } } void (Array instanceof Hook); }`,
    changes: true,
  },
  {
    id: 'object-on-the-left-of-an-instanceof-of-a-helper-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (Object instanceof helper); }`,
    changes: true,
  },
  {
    id: 'holder-on-the-left-through-a-cast-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void ((<any>Array) instanceof helper); }`,
    changes: true,
  },
  {
    id: 'holder-on-the-left-in-parentheses-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void ((Array) instanceof helper); }`,
    changes: true,
  },
  {
    id: 'holder-on-both-sides-of-an-instanceof-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (Array instanceof Array); }`,
    changes: true,
  },
  {
    id: 'global-object-holder-on-the-left-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (globalThis.Array instanceof helper); }`,
    changes: true,
  },
  {
    id: 'reflect-on-the-left-of-an-instanceof-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (Reflect instanceof helper); }`,
    changes: true,
  },
  {
    id: 'constructor-on-the-left-of-an-instanceof-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (a.constructor instanceof helper); }`,
    changes: true,
  },
  {
    id: 'constructor-on-the-left-of-an-instanceof-of-a-holder-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (a.constructor instanceof Object); }`,
    changes: true,
  },
  {
    id: 'prototype-answer-on-the-left-of-an-instanceof-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (Object.getPrototypeOf(a) instanceof helper); }`,
    changes: true,
  },
  {
    id: 'instanceof-pin-array-on-the-right',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (a instanceof Array); }`,
    changes: false,
  },
  {
    id: 'instanceof-pin-object-on-the-right',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (a instanceof Object); }`,
    changes: false,
  },
  {
    id: 'instanceof-pin-holder-on-the-right-through-a-cast',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (a instanceof (<any>Array)); }`,
    changes: false,
  },
  {
    id: 'instanceof-pin-constructor-on-the-right-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (helper instanceof a.constructor); }`,
    changes: true,
  },
  {
    id: 'instanceof-pin-global-holder-on-the-right-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (a instanceof globalThis.Array); }`,
    changes: true,
  },
  {
    id: 'comparison-pin-holder-on-the-left-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (Array === helper); }`,
    changes: true,
  },
  {
    id: 'comparison-pin-holder-on-the-right-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (helper !== Object); }`,
    changes: true,
  },
  {
    id: 'typeof-pin-holder',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (typeof Object); }`,
    changes: false,
  },
  {
    id: 'typeof-window-compared-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (typeof window !== 'undefined'); }`,
    changes: false,
  },
  {
    id: 'typeof-window-in-a-condition-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { const browser = typeof window === 'undefined' ? false : true; void browser; }`,
    changes: false,
  },
  {
    id: 'typeof-global-this-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (typeof globalThis === 'object'); }`,
    changes: false,
  },
  {
    id: 'typeof-self-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (typeof self === 'undefined'); }`,
    changes: false,
  },
  {
    id: 'typeof-global-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (typeof global === 'undefined'); }`,
    changes: false,
  },
  {
    id: 'typeof-window-in-parentheses-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (typeof (window) !== 'undefined'); }`,
    changes: false,
  },
  {
    id: 'typeof-window-through-a-cast-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (typeof (<any>window) !== 'undefined'); }`,
    changes: false,
  },
  {
    id: 'typeof-window-through-non-null-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (typeof window! !== 'undefined'); }`,
    changes: false,
  },
  {
    id: 'typeof-a-global-object-of-a-global-object-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (typeof globalThis.window !== 'undefined'); }`,
    changes: true,
  },
  {
    id: 'typeof-a-holder-of-a-global-object-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (typeof window.Array); }`,
    changes: true,
  },
  {
    id: 'window-bare-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void window; }`,
    changes: true,
  },
  {
    id: 'window-in-a-constant-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { const w = window; void w; }`,
    changes: true,
  },
  {
    id: 'window-compared-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (window === globalThis); }`,
    changes: true,
  },
  {
    id: 'window-given-to-a-call-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { helper(window); }`,
    changes: true,
  },
  {
    id: 'global-this-in-an-object-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void { g: globalThis }; }`,
    changes: true,
  },
  {
    id: 'typeof-window-then-a-member-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { if (typeof window !== 'undefined') void window.location; }`,
    changes: true,
  },
  {
    id: 'typeof-window-array-prototype-write-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { if (typeof window !== 'undefined') Object.defineProperty(window.Array.prototype, 'join', { set() {} }); }`,
    changes: true,
  },
  {
    id: 'typeof-of-a-member-of-a-global-object-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object) { void (typeof window.document); }`,
    changes: true,
  },
] as const;

describe('a file that tests a holder, or hands it to an instanceof hook', () => {
  it.each(CASES)('$id', ({ source, changes }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'prototype-tested-operands.ts', source);

    expect(prototypeMayChange(parsed.sourceFile)).toBe(changes);
  });
});
