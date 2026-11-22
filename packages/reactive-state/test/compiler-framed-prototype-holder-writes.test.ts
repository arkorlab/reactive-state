import { describe, expect, it } from 'vitest';

import { prototypeMayChange } from '../src/compiler/framed-prototype-changes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A member of a holder that the language names and that reaches no prototype (`Object.assign`,
 * `Object.keys`, `Array.from`) is a use only while it is the native, called by its name: a member
 * the code writes, deletes or steps (assigned, compound-assigned, a pattern's place, a loop head,
 * through a cast, parentheses or a global object) is another function from there on, and each call
 * of it that the file reads as a safe one runs what the code made. A member the list does not name
 * (`Reflect.set`, `Reflect.apply`, `Object.defineProperty`) is no use at all.
 */
const CASES = [
  {
    id: 'object-assign-assigned-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { Object.assign = fn as any; }`,
    changes: true,
  },
  {
    id: 'object-define-property-assigned-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { Object.defineProperty = fn as any; }`,
    changes: true,
  },
  {
    id: 'object-define-properties-assigned-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { Object.defineProperties = fn as any; }`,
    changes: true,
  },
  {
    id: 'reflect-set-assigned-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { Reflect.set = fn as any; }`,
    changes: true,
  },
  {
    id: 'reflect-apply-assigned-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { Reflect.apply = fn as any; }`,
    changes: true,
  },
  {
    id: 'reflect-define-property-assigned-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { Reflect.defineProperty = fn as any; }`,
    changes: true,
  },
  {
    id: 'object-assign-assigned-through-a-cast-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { (Object as any).assign = fn; }`,
    changes: true,
  },
  {
    id: 'object-assign-assigned-by-a-text-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { (Object as any)['assign'] = fn; }`,
    changes: true,
  },
  {
    id: 'object-assign-assigned-in-parentheses-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { (Object.assign) = fn as any; }`,
    changes: true,
  },
  {
    id: 'object-assign-assigned-through-a-cast-target-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { (Object.assign as any) = fn; }`,
    changes: true,
  },
  {
    id: 'object-assign-assigned-through-non-null-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { Object.assign! = fn as any; }`,
    changes: true,
  },
  {
    id: 'object-assign-compound-assigned-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { (Object as any).assign += fn; }`,
    changes: true,
  },
  {
    id: 'object-assign-logical-assigned-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { (Object as any).assign ||= fn; }`,
    changes: true,
  },
  {
    id: 'object-assign-nullish-assigned-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { (Object as any).assign ??= fn; }`,
    changes: true,
  },
  {
    id: 'object-assign-deleted-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { delete (Object as any).assign; }`,
    changes: true,
  },
  {
    id: 'object-assign-deleted-in-parentheses-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { delete ((Object as any).assign); }`,
    changes: true,
  },
  {
    id: 'object-assign-stepped-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { (Object as any).assign++; }`,
    changes: true,
  },
  {
    id: 'object-assign-stepped-before-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { --(Object as any).assign; }`,
    changes: true,
  },
  {
    id: 'object-assign-stepped-in-parentheses-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { ((Object as any).assign)++; }`,
    changes: true,
  },
  {
    id: 'object-assign-an-element-of-a-pattern-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { [Object.assign] = [fn as any]; }`,
    changes: true,
  },
  {
    id: 'object-assign-a-value-of-an-object-pattern-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { ({ a: Object.assign } = { a: fn as any }); }`,
    changes: true,
  },
  {
    id: 'object-assign-a-rest-of-a-list-pattern-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { [...Object.assign] = [fn as any]; }`,
    changes: true,
  },
  {
    id: 'object-assign-a-default-of-a-pattern-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { [Object.assign = fn as any] = []; }`,
    changes: true,
  },
  {
    id: 'object-assign-a-nested-pattern-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { [[Object.assign]] = [[fn as any]]; }`,
    changes: true,
  },
  {
    id: 'object-assign-a-for-of-head-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { for (Object.assign of list as any) {} }`,
    changes: true,
  },
  {
    id: 'object-assign-a-for-in-head-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { for (Object.assign in source) {} }`,
    changes: true,
  },
  {
    id: 'global-object-assign-assigned-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { globalThis.Object.assign = fn as any; }`,
    changes: true,
  },
  {
    id: 'window-object-assign-assigned-by-texts-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { (window as any)['Object']['assign'] = fn; }`,
    changes: true,
  },
  {
    id: 'object-keys-assigned-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { Object.keys = fn as any; }`,
    changes: true,
  },
  {
    id: 'object-keys-deleted-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { delete (Object as any).keys; }`,
    changes: true,
  },
  {
    id: 'object-get-prototype-of-assigned-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { Object.getPrototypeOf = fn as any; }`,
    changes: true,
  },
  {
    id: 'object-get-prototype-of-deleted-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { delete (Object as any).getPrototypeOf; }`,
    changes: true,
  },
  {
    id: 'reflect-get-prototype-of-pattern-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { [Reflect.getPrototypeOf] = [fn as any]; }`,
    changes: true,
  },
  {
    id: 'reflect-has-for-head-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { for (Reflect.has of list as any) {} }`,
    changes: true,
  },
  {
    id: 'array-from-assigned-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { Array.from = fn as any; }`,
    changes: true,
  },
  {
    id: 'array-of-stepped-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { (Array as any).of++; }`,
    changes: true,
  },
  {
    id: 'object-freeze-an-element-of-a-pattern-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { [Object.freeze] = [fn as any]; }`,
    changes: true,
  },
  {
    id: 'object-assign-assigned-in-a-condition-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { if ((Object.assign = fn as any)) void 0; }`,
    changes: true,
  },
  {
    id: 'object-assign-called-after-assigned-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { (Object.assign = fn as any)(a, {}); }`,
    changes: true,
  },
  {
    id: 'object-assign-called-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { Object.assign(a, {}); }`,
    changes: false,
  },
  {
    id: 'object-assign-held-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { const copy = Object.assign; void copy; }`,
    changes: true,
  },
  {
    id: 'object-assign-given-to-a-call-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { helper(Object.assign); }`,
    changes: true,
  },
  {
    id: 'object-assign-in-a-list-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void [Object.assign]; }`,
    changes: true,
  },
  {
    id: 'object-assign-called-through-call-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { Object.assign.call(null, a, {}); }`,
    changes: true,
  },
  {
    id: 'reflect-apply-called-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { Reflect.apply(fn, null, []); }`,
    changes: true,
  },
  {
    id: 'object-assign-typeof-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void (typeof Object.assign); }`,
    changes: true,
  },
  {
    id: 'object-define-property-called-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { Object.defineProperty(source, 'x', { value: 1 }); }`,
    changes: true,
  },
  {
    id: 'object-keys-called-pin',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void Object.keys(source); }`,
    changes: false,
  },
  {
    id: 'object-assign-compared-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void (Object.assign === helper); }`,
    changes: true,
  },
  {
    id: 'object-assign-an-element-read-in-a-pattern-source-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { const [first] = [Object.assign]; void first; }`,
    changes: true,
  },
  {
    id: 'object-assign-negated-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void !Object.assign; }`,
    changes: true,
  },
  {
    id: 'object-assign-negated-in-a-condition-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { if (!Object.assign) { void a; } }`,
    changes: true,
  },
  {
    id: 'reflect-set-negated-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void !Reflect.set; }`,
    changes: true,
  },
  {
    id: 'object-assign-negated-through-a-cast-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void !(Object as any).assign; }`,
    changes: true,
  },
  {
    id: 'object-assign-minus-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void -Object.assign; }`,
    changes: true,
  },
  {
    id: 'object-assign-plus-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void +Object.assign; }`,
    changes: true,
  },
  {
    id: 'object-assign-complemented-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void ~Object.assign; }`,
    changes: true,
  },
  {
    id: 'array-prototype-join-negated-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { void !Array.prototype.join; }`,
    changes: true,
  },
  {
    id: 'object-assign-stepped-before-in-parentheses-refused',
    source: `function frames(helper: any, a: unknown[], key: string, p: object, fn: () => void, date: Date, source: object, list: (() => void)[]) { ++((Object as any).assign); }`,
    changes: true,
  },
] as const;

describe('a file that writes, deletes or steps a member of a holder', () => {
  it.each(CASES)('$id', ({ source, changes }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'prototype-holde.ts', source);

    expect(prototypeMayChange(parsed.sourceFile)).toBe(changes);
  });
});
