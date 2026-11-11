import {
  type Expression,
  isCallExpression,
  isIdentifier,
  isReturnStatement,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { writtenArrayElements } from '../src/compiler/framed-array-elements.ts';
import { framedArrayString } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * What a native object mutator installs from a source the compile cannot read: at an unknown
 * position any element the source holds as an array or a tuple does, and a getter that answers
 * later installs a promise, which is no error.
 */
const VALUES = "const values: unknown[] = ['safe'];";

const ELEMENTS = [
  {
    id: 'assign-tuple-source',
    source: `function frames(pair: [string, Error]) { ${VALUES} Object.assign(values, pair); return values; }`,
    index: undefined,
    elements: ['pair:0', 'pair:array'],
  },
  {
    id: 'assign-spread-field-source',
    source: `function frames(pair: [string, Error]) { ${VALUES} Object.assign(values, { ...pair }); return values; }`,
    index: undefined,
    elements: ['pair:0', 'pair:array'],
  },
  {
    id: 'assign-tuple-source-at-index-pin',
    source: `function frames(pair: [string, Error]) { ${VALUES} Object.assign(values, pair); return values; }`,
    index: 1,
    elements: ['pair:1'],
  },
  {
    id: 'define-async-getter',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { async get() { return error; } }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'define-generator-getter-pin',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { *get() { yield error; } }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'assign-getter-constant-local',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, { get 0() { const held = error; return held; } }); return values; }`,
    index: undefined,
    elements: ['held:'],
  },
  {
    id: 'define-getter-constant-local',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { get() { const held = error; return held; } }); return values; }`,
    index: undefined,
    elements: ['held:'],
  },
  {
    id: 'define-arrow-getter',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { get: () => error }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-function-getter',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { get: function () { return error; } }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-async-arrow-getter-pin',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { get: async () => error }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'assign-getter-mutable-local',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, { get 0() { let held = error; held = error; return held; } }); return values; }`,
    index: undefined,
    elements: ['held:'],
  },
  {
    id: 'assign-getter-try',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, { get 0() { try { return error; } finally { touch(); } } }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-getter-call-first',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { get() { touch(); return error; } }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'assign-getter-nested-function',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, { get 0() { let later = () => { return error; }; later = later; return 'safe'; } }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'assign-last-index-pin',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, { '4294967294': error }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'assign-past-last-index',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, { '4294967295': error }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'define-past-last-index',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 4294967296, { value: error }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'define-named-getter',
    source: `function frames(error: Error) { ${VALUES} function getter() { return error; } Object.defineProperty(values, 0, { get: getter }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-constant-getter',
    source: `function frames(error: Error) { ${VALUES} const alias = () => error; const getter = alias; Object.defineProperty(values, 0, { get: getter }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-shorthand-getter',
    source: `function frames(error: Error) { ${VALUES} const get = () => error; Object.defineProperty(values, 0, { get }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-getter-named-get',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { get get() { return () => error; } }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-getter-named-value',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { get value() { return error; } }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-descriptor-alias',
    source: `function frames(error: Error) { ${VALUES} const descriptor = { get: () => error }; Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', 'error:'],
  },
  {
    id: 'define-destructured-descriptor',
    source: `function frames(error: Error) { ${VALUES} const { descriptor } = { descriptor: { value: 'safe' }, get: () => error }; Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value'],
  },
  {
    id: 'define-spread-maps',
    source: `function frames(maps: PropertyDescriptorMap[]) { ${VALUES} Object.defineProperties(values, ...maps); return values; }`,
    index: undefined,
    elements: ['maps:0.0.value'],
  },
  {
    id: 'define-spread-descriptor',
    source: `function frames(rest: [PropertyDescriptor]) { ${VALUES} Object.defineProperty(values, 0, ...rest); return values; }`,
    index: undefined,
    elements: ['rest:0.value'],
  },
  {
    id: 'define-spread-key',
    source: `function frames(rest: [PropertyKey, PropertyDescriptor]) { ${VALUES} Object.defineProperty(values, ...rest); return values; }`,
    index: undefined,
    elements: ['rest:1.value'],
  },
  {
    id: 'define-spread-key-then-descriptor',
    source: `function frames(error: Error, keys: [number]) { ${VALUES} Object.defineProperty(values, ...keys, { value: error }); return values; }`,
    index: undefined,
    elements: ['keys:1.value', 'error:'],
  },
  {
    id: 'define-spread-maps-then-map',
    source: `function frames(error: Error, maps: PropertyDescriptorMap[]) { ${VALUES} Object.defineProperties(values, ...maps, { 0: { value: error } }); return values; }`,
    index: undefined,
    elements: ['maps:0.0.value', 'error:'],
  },
  {
    id: 'assign-spread-list-sources',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, ...[{}, { 0: error }]); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'assign-spread-list-at-index',
    source: `function frames(error: Error, other: Error) { ${VALUES} Object.assign(values, ...[{ 0: other }, { 1: error }]); return values; }`,
    index: 1,
    elements: ['error:'],
  },
  {
    id: 'assign-spread-constant-list',
    source: `function frames(error: Error) { ${VALUES} const list = [{}, { 0: error }]; Object.assign(values, ...list); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'assign-spread-list-with-opaque',
    source: `function frames(error: Error, rest: [object]) { ${VALUES} Object.assign(values, ...[{ 0: error }, ...rest]); return values; }`,
    index: undefined,
    elements: ['error:', 'rest:0.0'],
  },
  {
    id: 'assign-spread-opaque-pin',
    source: `function frames(rest: [object]) { ${VALUES} Object.assign(values, ...rest); return values; }`,
    index: undefined,
    elements: ['rest:0.0'],
  },
  {
    id: 'define-map-getter',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperties(values, { get 0() { return { value: error }; } }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-map-getter-descriptor-getter',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperties(values, { get 0() { return { get: () => error }; } }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-map-getter-other-key-pin',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperties(values, { get label() { return { value: error }; } }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'define-known-spread-label',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, ...['label'] as const, { value: error }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'define-known-spread-index',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, ...[0] as const, { value: error }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-known-spread-other-index-pin',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, ...[1] as const, { value: error }); return values; }`,
    index: 0,
    elements: [],
  },
  {
    id: 'define-known-spread-descriptor',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, ...[{ value: error }]); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-known-spread-maps',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperties(values, ...[{ 0: { value: error } }]); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-async-named-getter-pin',
    source: `function frames(error: Error) { ${VALUES} async function getter() { return error; } Object.defineProperty(values, 0, { get: getter }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'assign-getter-nested-class',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, { get 0() { class Holder { constructor() { return error; } } return 'safe'; } }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'define-getter-pin',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { get() { return error; } }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
] as const;

describe('elements native object mutators install from unread sources', () => {
  it.each(ELEMENTS)('$id', ({ source, index, elements }) => {
    expect(writtenElements(source, index)).toStrictEqual(elements);
  });
});

const CONVERSIONS = [
  {
    id: 'reviewed-assign-index-pin',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { 0: error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-property-pin',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperty(a, 0, { value: error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-spread-key-then-descriptor-converts',
    source: `function frames(error: Error, keys: [number]) { const a = ['safe']; Object.defineProperty(a, ...keys, { value: error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-spread-list-converts',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, ...[{}, { 0: error }]); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-map-getter-converts',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperties(a, { get 0() { return { value: error }; } }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-known-spread-label-safe',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperty(a, ...['label'] as const, { value: error }); return String(a); }`,
    converts: false,
  },
  {
    id: 'tuple-source',
    source: `function frames(pair: [string, Error]) { const a = ['safe']; Object.assign(a, pair); return String(a); }`,
    converts: true,
  },
  {
    id: 'past-last-index',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { '4294967295': error }); return String(a); }`,
    converts: false,
  },
  {
    id: 'arrow-getter',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperty(a, 0, { get: () => error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'named-getter',
    source: `function frames(error: Error) { const a = ['safe']; function getter() { return error; } Object.defineProperty(a, 0, { get: getter }); return String(a); }`,
    converts: true,
  },
  {
    id: 'nested-class-getter',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { get 0() { class Holder { constructor() { return error; } } return 'safe'; } }); return String(a); }`,
    converts: false,
  },
  {
    id: 'named-key-pin',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { label: error }); return String(a); }`,
    converts: false,
  },
  {
    id: 'later-statement-pin',
    source: `function frames(error: Error) { const a = ['safe']; const text = String(a); Object.assign(a, { 0: error }); return text; }`,
    converts: false,
  },
] as const;

describe('text conversion of an array a native object mutator wrote an error to', () => {
  it.each(CONVERSIONS)('$id', ({ source, converts }) => {
    expect(convertsError(source)).toBe(converts);
  });
});

/** The written elements of the returned array at the index, with their paths. */
function writtenElements(source: string, index: number | undefined): readonly string[] {
  using api = openTypeScript();
  using parsed = parseModule(api, 'object-mutator-sources.ts', source);
  const read = returned(parsed.sourceFile);
  return writtenArrayElements(read, read, index).map((each) => {
    const path = each.array === true ? 'array' : each.keys.join('.');
    return `${each.value.getText()}:${path}`;
  });
}

function returned(root: Node): Expression {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isReturnStatement(node) && node.expression !== undefined && isIdentifier(node.expression))
      return node.expression;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no returned name');
}

/** Whether the source's `String(array)` converts the `error` element or a tuple of `pair`. */
function convertsError(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'object-mutator-conversions.ts', source);
  const words = {
    error: (value: Expression, keys?: readonly string[]) => {
      const each = unwrapped(value);
      return (
        (keys === undefined || keys.length === 0) && isIdentifier(each) && each.text === 'error'
      );
    },
    typed: (value: Expression) => {
      const each = unwrapped(value);
      return isIdentifier(each) && each.text === 'pair';
    },
  };
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === 'String' &&
      framedArrayString(node.arguments[0], words, node)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
