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
    id: 'define-explicit-key-spread-then-descriptor',
    source: `function frames(error: Error, descriptors: PropertyDescriptor[]) { ${VALUES} Object.defineProperty(values, 0, ...descriptors, { value: error }); return values; }`,
    index: undefined,
    elements: ['descriptors:0.value', 'error:'],
  },
  {
    id: 'define-two-spreads-then-descriptor',
    source: `function frames(error: Error, keys: [number], more: PropertyDescriptor[]) { ${VALUES} Object.defineProperty(values, ...keys, ...more, { value: error }); return values; }`,
    index: undefined,
    elements: ['keys:1.value', 'more:0.value', 'more:1.value', 'error:'],
  },
  {
    id: 'define-spread-then-extra-arguments',
    source: `function frames(keys: number[], a: Error, b: Error, c: Error) { ${VALUES} Object.defineProperty(values, ...keys, { value: a }, { value: b }, { value: c }); return values; }`,
    index: undefined,
    elements: ['keys:1.value', 'a:', 'b:'],
  },
  {
    id: 'define-maps-two-spreads-then-map',
    source: `function frames(error: Error, maps: PropertyDescriptorMap[], more: PropertyDescriptorMap[]) { ${VALUES} Object.defineProperties(values, ...maps, ...more, { 0: { value: error } }); return values; }`,
    index: undefined,
    elements: ['maps:0.0.value', 'more:0.0.value', 'error:'],
  },
  {
    id: 'define-maps-spread-then-extra-maps',
    source: `function frames(maps: PropertyDescriptorMap[], a: Error, b: Error) { ${VALUES} Object.defineProperties(values, ...maps, { 0: { value: a } }, { 0: { value: b } }); return values; }`,
    index: undefined,
    elements: ['maps:0.0.value', 'a:'],
  },
  {
    id: 'define-descriptor-spread-getter',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { ...{ get: () => error } }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-descriptor-spread-value',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { ...{ value: error } }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-descriptor-nested-spread',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { ...{ ...{ get: () => error } } }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-descriptor-spread-other-field',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { ...{ enumerable: error } }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'define-descriptor-spread-opaque-pin',
    source: `function frames(descriptor: PropertyDescriptor) { ${VALUES} Object.defineProperty(values, 0, { ...descriptor }); return values; }`,
    index: undefined,
    elements: ['descriptor:value'],
  },
  {
    id: 'define-constant-label-key',
    source: `function frames(error: Error) { ${VALUES} const key = 'label'; Object.defineProperty(values, key, { value: error }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'define-constant-index-key',
    source: `function frames(error: Error) { ${VALUES} const key = 0; Object.defineProperty(values, key, { value: error }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-constant-other-index-key',
    source: `function frames(error: Error) { ${VALUES} const key = 1; Object.defineProperty(values, key, { value: error }); return values; }`,
    index: 0,
    elements: [],
  },
  {
    id: 'define-annotated-names-key',
    source: `function frames(error: Error, key: 'label' | 'name') { ${VALUES} Object.defineProperty(values, key, { value: error }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'define-annotated-index-key',
    source: `function frames(error: Error, key: 'label' | '0') { ${VALUES} Object.defineProperty(values, key, { value: error }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-opaque-key-pin',
    source: `function frames(error: Error, key: string) { ${VALUES} Object.defineProperty(values, key, { value: error }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'assign-constant-computed-label',
    source: `function frames(error: Error) { ${VALUES} const key = 'label'; Object.assign(values, { [key]: error }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'assign-constant-computed-index',
    source: `function frames(error: Error) { ${VALUES} const key = 0; Object.assign(values, { [key]: error }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-map-constant-label',
    source: `function frames(error: Error) { ${VALUES} const key = 'label'; Object.defineProperties(values, { [key]: { value: error } }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'define-map-constant-index',
    source: `function frames(error: Error) { ${VALUES} const key = 0; Object.defineProperties(values, { [key]: { value: error } }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-descriptor-proto',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { __proto__: { value: error }, configurable: true } as PropertyDescriptor); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-descriptor-proto-getter',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { __proto__: { get: () => error } } as PropertyDescriptor); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-descriptor-proto-own-value',
    source: `function frames(error: Error, other: string) { ${VALUES} Object.defineProperty(values, 0, { __proto__: { value: error }, value: other } as PropertyDescriptor); return values; }`,
    index: undefined,
    elements: ['other:'],
  },
  {
    id: 'define-descriptor-computed-proto-pin',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { ['__proto__']: { value: error } } as PropertyDescriptor); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'define-map-descriptor-proto',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperties(values, { 0: { __proto__: { value: error } } as PropertyDescriptor }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'assign-spread-target',
    source: `function frames(error: Error) { ${VALUES} Object.assign(...[values] as const, { 0: error }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'assign-spread-list-with-target',
    source: `function frames(error: Error) { ${VALUES} Object.assign(...[values, { 0: error }]); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'assign-constant-spread-target',
    source: `function frames(error: Error) { ${VALUES} const args = [values, { 0: error }]; Object.assign(...args); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'assign-nested-spread-list',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, ...[{}, ...[{ 0: error }]]); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-spread-target',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(...[values, 0] as const, { value: error }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-spread-everything',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(...[values, 0, { value: error }]); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-maps-spread-target',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperties(...[values, { 0: { value: error } }]); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'assign-spread-unresolved-target-pin',
    source: `function frames(error: Error, args: unknown[]) { ${VALUES} Object.assign(...args, { 0: error }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'assign-spread-list-hole-pin',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, ...[, { 0: error }]); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-constant-map-getter',
    source: `function frames(error: Error) { ${VALUES} const descriptors = { 0: { get: () => error } }; Object.defineProperties(values, descriptors); return values; }`,
    index: undefined,
    elements: ['descriptors:0.value', 'error:'],
  },
  {
    id: 'define-constant-map-value',
    source: `function frames(error: Error) { ${VALUES} const descriptors = { 0: { value: error } }; Object.defineProperties(values, descriptors); return values; }`,
    index: undefined,
    elements: ['descriptors:0.value', 'error:'],
  },
  {
    id: 'define-constant-map-other-key-pin',
    source: `function frames(error: Error) { ${VALUES} const descriptors = { label: { get: () => error } }; Object.defineProperties(values, descriptors); return values; }`,
    index: undefined,
    elements: ['descriptors:0.value'],
  },
  {
    id: 'define-map-spread-literal',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperties(values, { ...{ 0: { get: () => error } } }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-map-spread-opaque-pin',
    source: `function frames(maps: PropertyDescriptorMap) { ${VALUES} Object.defineProperties(values, { ...maps }); return values; }`,
    index: undefined,
    elements: ['maps:0.value'],
  },
  {
    id: 'assign-spread-property-literal',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, { ...{ get 0() { return error; } } }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'assign-spread-property-array-literal',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, { ...[error] }); return values; }`,
    index: undefined,
    elements: ['[error]:array'],
  },
  {
    id: 'define-reassigned-getter-declaration',
    source: `function frames(error: Error) { ${VALUES} function getter(): unknown { return 'safe'; } getter = () => error; Object.defineProperty(values, 0, { get: getter }); return values; }`,
    index: undefined,
    elements: ["'safe':", 'error:'],
  },
  {
    id: 'define-reassigned-getter-variable',
    source: `function frames(error: Error) { ${VALUES} let getter = () => 'safe'; getter = () => error; Object.defineProperty(values, 0, { get: getter }); return values; }`,
    index: undefined,
    elements: ["'safe':", 'error:'],
  },
  {
    id: 'define-getter-declaration-pin',
    source: `function frames(error: Error) { ${VALUES} function getter(): unknown { return 'safe'; } Object.defineProperty(values, 0, { get: getter }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'define-getter-reassigned-later-pin',
    source: `function frames(error: Error) { ${VALUES} function getter(): unknown { return 'safe'; } Object.defineProperty(values, 0, { get: getter }); getter = () => error; return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'define-overloaded-getter',
    source: `function frames(error: Error) { ${VALUES} function getter(): string; function getter(): unknown { return error; } Object.defineProperty(values, 0, { get: getter }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-overloaded-getter-parameters',
    source: `function frames(error: Error) { ${VALUES} function getter(flag: true): string; function getter(flag: boolean): unknown { return error; } Object.defineProperty(values, 0, { get: getter }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-overloaded-reassigned-getter',
    source: `function frames(error: Error) { ${VALUES} function getter(): string; function getter(): unknown { return 'safe'; } getter = () => error; Object.defineProperty(values, 0, { get: getter }); return values; }`,
    index: undefined,
    elements: ["'safe':", 'error:'],
  },
  {
    id: 'define-repeated-constant-list',
    source: `function frames(error: Error) { ${VALUES} const empty: never[] = []; Object.defineProperty(values, ...empty, ...empty, 'label', { value: error }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'define-repeated-constant-list-index',
    source: `function frames(error: Error) { ${VALUES} const empty: never[] = []; Object.defineProperty(values, ...empty, ...empty, 0, { value: error }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-descriptor-spread-prototype-pin',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { ...{ __proto__: { value: error } } } as PropertyDescriptor); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'define-descriptor-spread-prototype-getter-pin',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { ...{ __proto__: { get: () => error } } } as PropertyDescriptor); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'define-descriptor-prototype-of-spread',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { __proto__: { ...{ value: error } } } as PropertyDescriptor); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-conditional-getter',
    source: `function frames(error: Error, flag: boolean) { ${VALUES} Object.defineProperty(values, 0, { get: flag ? () => error : () => 'safe' }); return values; }`,
    index: undefined,
    elements: ['error:', "'safe':"],
  },
  {
    id: 'define-logical-getter',
    source: `function frames(error: Error, flag: boolean) { ${VALUES} Object.defineProperty(values, 0, { get: flag && (() => error) } as PropertyDescriptor); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-conditional-alias-getter',
    source: `function frames(error: Error, flag: boolean) { ${VALUES} const getter = flag ? () => error : () => 'safe'; Object.defineProperty(values, 0, { get: getter }); return values; }`,
    index: undefined,
    elements: ['error:', "'safe':"],
  },
  {
    id: 'define-constant-getter-assigned',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = { get: () => 'safe' }; descriptor.get = () => error; Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', "'safe':", 'error:'],
  },
  {
    id: 'define-constant-value-assigned',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = { value: 'safe' }; descriptor.value = error; Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', "'safe':", 'error:'],
  },
  {
    id: 'define-constant-getter-assigned-through-alias',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = { get: () => 'safe' }; const alias = descriptor; alias.get = () => error; Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', "'safe':", 'error:'],
  },
  {
    id: 'define-constant-getter-assigned-by-name',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = { get: () => 'safe' }; descriptor['get'] = () => error; Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', "'safe':", 'error:'],
  },
  {
    id: 'define-constant-other-field-assigned-pin',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = { get: () => 'safe' }; descriptor.enumerable = error; Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', "'safe':"],
  },
  {
    id: 'define-constant-other-object-assigned-pin',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = { get: () => 'safe' }; const other: PropertyDescriptor = {}; other.get = () => error; Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', "'safe':"],
  },
  {
    id: 'define-self-referential-getter',
    source: `function frames(error: Error) { ${VALUES} const getter: () => unknown = true ? () => 'safe' : getter; Object.defineProperty(values, 0, { get: getter }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'define-mutually-referential-getters',
    source: `function frames(error: Error, flag: boolean) { ${VALUES} const first: () => unknown = flag ? () => 'safe' : second; const second: () => unknown = flag ? first : () => error; Object.defineProperty(values, 0, { get: first }); return values; }`,
    index: undefined,
    elements: ["'safe':", 'error:'],
  },
  {
    id: 'define-reassigned-alias-write-pin',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = { get: () => 'safe' }; let alias = descriptor; alias = {}; alias.get = () => error; Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', "'safe':"],
  },
  {
    id: 'define-literal-condition-getter',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { get: true ? () => 'safe' : () => error }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'define-self-referential-getter-literal',
    source: `function frames(error: Error) { ${VALUES} const getter: () => unknown = true ? () => error : getter; Object.defineProperty(values, 0, { get: getter }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-conditional-descriptor',
    source: `function frames(error: Error, flag: boolean) { ${VALUES} Object.defineProperty(values, 0, flag ? { get: () => error } : {}); return values; }`,
    index: undefined,
    elements: ['flag ? { get: () => error } : {}:value', 'error:'],
  },
  {
    id: 'define-constant-conditional-descriptor',
    source: `function frames(error: Error, flag: boolean) { ${VALUES} const descriptor: PropertyDescriptor = flag ? { get: () => error } : {}; Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', 'error:'],
  },
  {
    id: 'define-literal-condition-descriptor',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, true ? { value: error } : { value: 'safe' }); return values; }`,
    index: undefined,
    elements: ["true ? { value: error } : { value: 'safe' }:value", 'error:'],
  },
  {
    id: 'define-conditional-map',
    source: `function frames(error: Error, flag: boolean) { ${VALUES} Object.defineProperties(values, flag ? { 0: { value: error } } : {}); return values; }`,
    index: undefined,
    elements: ['flag ? { 0: { value: error } } : {}:0.value', 'error:'],
  },
  {
    id: 'assign-conditional-source',
    source: `function frames(error: Error, flag: boolean) { ${VALUES} Object.assign(values, flag ? { 0: error } : {}); return values; }`,
    index: undefined,
    elements: ['flag ? { 0: error } : {}:0', 'flag ? { 0: error } : {}:array', 'error:'],
  },
  {
    id: 'define-constant-conditional-descriptor-assigned',
    source: `function frames(error: Error, flag: boolean) { ${VALUES} const descriptor: PropertyDescriptor = flag ? { get: () => 'safe' } : {}; descriptor.get = () => error; Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', "'safe':", 'error:'],
  },
  {
    id: 'define-constant-logical-descriptor-assigned',
    source: `function frames(error: Error, base: PropertyDescriptor) { ${VALUES} const descriptor: PropertyDescriptor = base || { value: 'safe' }; descriptor.value = error; Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', 'base:value', "'safe':", 'error:'],
  },
  {
    id: 'define-constant-conditional-descriptor-other-object-pin',
    source: `function frames(error: Error, flag: boolean) { ${VALUES} const descriptor: PropertyDescriptor = flag ? { get: () => 'safe' } : {}; const other: PropertyDescriptor = {}; other.get = () => error; Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', "'safe':"],
  },
  {
    id: 'define-getter-reference-after-alias',
    source: `function frames(error: Error, flag: boolean) { ${VALUES} function f(): unknown { return 'safe'; } const alias = f; f = () => error; Object.defineProperty(values, 0, { get: flag ? alias : f }); return values; }`,
    index: undefined,
    elements: ["'safe':", 'error:'],
  },
  {
    id: 'define-getter-references-assigned-between',
    source: `function frames(error: Error, flag: boolean) { ${VALUES} function f(): unknown { return 'safe'; } f = () => error; const alias = f; Object.defineProperty(values, 0, { get: flag ? alias : f }); return values; }`,
    index: undefined,
    elements: ["'safe':", 'error:'],
  },
  {
    id: 'define-let-alias-write',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = { get: () => 'safe' }; let alias = descriptor; alias.get = () => error; Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', "'safe':", 'error:'],
  },
  {
    id: 'assign-constant-getter-source',
    source: `function frames(error: Error) { ${VALUES} const source = { get 1(): unknown { return error; } }; Object.assign(values, source); return values; }`,
    index: undefined,
    elements: ['source:0', 'source:array', 'error:'],
  },
  {
    id: 'assign-constant-value-source',
    source: `function frames(error: Error) { ${VALUES} const source = { 0: error }; Object.assign(values, source); return values; }`,
    index: undefined,
    elements: ['source:0', 'source:array', 'error:'],
  },
  {
    id: 'assign-constant-conditional-source',
    source: `function frames(error: Error, flag: boolean) { ${VALUES} const source = flag ? { 0: error } : {}; Object.assign(values, source); return values; }`,
    index: undefined,
    elements: ['source:0', 'source:array', 'error:'],
  },
  {
    id: 'assign-constant-other-key-source-pin',
    source: `function frames(error: Error) { ${VALUES} const source = { label: error }; Object.assign(values, source); return values; }`,
    index: undefined,
    elements: ['source:0', 'source:array'],
  },
  {
    id: 'assign-constant-spread-source',
    source: `function frames(error: Error) { ${VALUES} const base = { 0: error }; const source = { ...base }; Object.assign(values, source); return values; }`,
    index: undefined,
    elements: ['source:0', 'source:array', 'base:0', 'base:array', 'error:'],
  },
  {
    id: 'define-constant-computed-other-field',
    source: `function frames(error: Error) { ${VALUES} const key = 'metadata'; const descriptor: PropertyDescriptor = { [key]: error, configurable: true }; Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value'],
  },
  {
    id: 'define-inline-constant-computed-other-field',
    source: `function frames(error: Error) { ${VALUES} const key = 'metadata'; Object.defineProperty(values, 0, { [key]: error } as PropertyDescriptor); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'define-constant-computed-value-field',
    source: `function frames(error: Error) { ${VALUES} const key = 'value'; Object.defineProperty(values, 0, { [key]: error }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-annotated-computed-other-fields',
    source: `function frames(error: Error, key: 'metadata' | 'other') { ${VALUES} Object.defineProperty(values, 0, { [key]: error } as PropertyDescriptor); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'define-annotated-computed-value-or-other-field',
    source: `function frames(error: Error, key: 'value' | 'metadata') { ${VALUES} Object.defineProperty(values, 0, { [key]: error } as PropertyDescriptor); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-opaque-computed-field-pin',
    source: `function frames(error: Error, key: string) { ${VALUES} Object.defineProperty(values, 0, { [key]: error } as PropertyDescriptor); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-constant-getter-logical-assigned',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = { get: undefined }; descriptor.get ??= () => error; Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', 'error:'],
  },
  {
    id: 'define-constant-getter-or-assigned',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = { get: undefined }; descriptor.get ||= () => error; Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', 'error:'],
  },
  {
    id: 'define-constant-getter-and-assigned',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = { get: () => 'safe' }; descriptor.get &&= () => error; Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', "'safe':", 'error:'],
  },
  {
    id: 'define-constant-value-added-pin',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = { value: 1 }; descriptor.value += error; Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', '1:'],
  },
  {
    id: 'assign-short-circuited-source',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, false && { 0: error }); return values; }`,
    index: undefined,
    elements: ['false && { 0: error }:0', 'false && { 0: error }:array', 'false:0', 'false:array'],
  },
  {
    id: 'assign-nullish-source',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, null ?? { 0: error }); return values; }`,
    index: undefined,
    elements: ['null ?? { 0: error }:0', 'null ?? { 0: error }:array', 'error:'],
  },
  {
    id: 'assign-truthy-and-source',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, true && { 0: error }); return values; }`,
    index: undefined,
    elements: ['true && { 0: error }:0', 'true && { 0: error }:array', 'error:'],
  },
  {
    id: 'assign-truthy-or-source',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, true || { 0: error }); return values; }`,
    index: undefined,
    elements: ['true || { 0: error }:0', 'true || { 0: error }:array', 'true:0', 'true:array'],
  },
  {
    id: 'assign-non-nullish-source',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, 0 ?? { 0: error }); return values; }`,
    index: undefined,
    elements: ['0 ?? { 0: error }:0', '0 ?? { 0: error }:array', '0:0', '0:array'],
  },
  {
    id: 'define-short-circuited-descriptor',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, false && { value: error }); return values; }`,
    index: undefined,
    elements: ['false && { value: error }:value', 'false:value'],
  },
  {
    id: 'assign-unknown-and-source-pin',
    source: `function frames(error: Error, flag: boolean) { ${VALUES} Object.assign(values, flag && { 0: error }); return values; }`,
    index: undefined,
    elements: [
      'flag && { 0: error }:0',
      'flag && { 0: error }:array',
      'flag:0',
      'flag:array',
      'error:',
    ],
  },
  {
    id: 'define-symbol-key',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, Symbol.iterator, { value: error }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'define-symbol-call-key',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, Symbol('label'), { value: error }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'define-constant-symbol-key',
    source: `function frames(error: Error) { ${VALUES} const key = Symbol('label'); Object.defineProperty(values, key, { value: error }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'assign-symbol-computed-key',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, { [Symbol.iterator]: error }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'define-map-symbol-key',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperties(values, { [Symbol.iterator]: { value: error } }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'define-nullish-constant-getter',
    source: `function frames(error: Error) { ${VALUES} const empty = null; Object.defineProperty(values, 0, { get: empty ?? (() => error) }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-shadowed-undefined-getter',
    source: `function frames(error: Error) { ${VALUES} const undefined = () => error; Object.defineProperty(values, 0, { get: undefined ?? (() => 'safe') }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-present-constant-getter',
    source: `function frames(error: Error) { ${VALUES} const present = () => 'safe'; Object.defineProperty(values, 0, { get: present ?? (() => error) }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'assign-nullish-constant-source',
    source: `function frames(error: Error) { ${VALUES} const empty = null; Object.assign(values, empty ?? { 0: error }); return values; }`,
    index: undefined,
    elements: ['empty ?? { 0: error }:0', 'empty ?? { 0: error }:array', 'error:'],
  },
  {
    id: 'define-key-for-key',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, { [Symbol.keyFor(Symbol.for('0'))!]: error }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-symbol-length-key',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, Symbol.length, { value: error }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'assign-chained-target',
    source: `function frames(error: Error) { ${VALUES} Object.assign(Object.assign(values, {}), { 0: error }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-chained-target',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(Object.assign(values, {}), 0, { value: error }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'assign-chained-freeze-target',
    source: `function frames(error: Error) { ${VALUES} Object.assign(Object.freeze(values), { 0: error }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'assign-doubly-chained-target',
    source: `function frames(error: Error) { ${VALUES} Object.assign(Object.defineProperty(Object.assign(values, {}), 'label', { value: 1 }), { 0: error }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'assign-unknown-call-target-pin',
    source: `function frames(error: Error, helper: (value: unknown[]) => unknown[]) { ${VALUES} Object.assign(helper(values), { 0: error }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'define-reassigned-function-nullish-getter',
    source: `function frames(error: Error) { ${VALUES} function getter(): unknown { return 'safe'; } getter = undefined!; Object.defineProperty(values, 0, { get: getter ?? (() => error) }); return values; }`,
    index: undefined,
    elements: ["'safe':", 'error:'],
  },
  {
    id: 'define-unassigned-function-nullish-getter-pin',
    source: `function frames(error: Error) { ${VALUES} function getter(): unknown { return 'safe'; } Object.defineProperty(values, 0, { get: getter ?? (() => error) }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'assign-later-field-hides-spread-entry',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, { ...{ 0: error }, 0: 'safe' }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'assign-later-getter-hides-spread-entry',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, { ...{ 0: error }, get 0() { return 'safe'; } }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'assign-getter-then-setter-keeps-getter',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, { get 0() { return error; }, set 0(value: Error) {} }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'assign-spread-getter-then-setter-hides',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, { ...{ get 0() { return error; } }, set 0(value: Error) {} }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'assign-spread-entry-after-field-hides-it',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, { 0: error, ...{ 0: 'safe' } }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'assign-opaque-spread-keeps-earlier-field-pin',
    source: `function frames(error: Error, rest: object) { ${VALUES} Object.assign(values, { 0: error, ...rest }); return values; }`,
    index: undefined,
    elements: ['error:', 'rest:0', 'rest:array'],
  },
  {
    id: 'assign-computed-later-field-hides',
    source: `function frames(error: Error) { ${VALUES} const key = 0; Object.assign(values, { 0: error, [key]: 'safe' }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'assign-source-hidden-then-visible',
    source: `function frames(error: Error) { ${VALUES} const source = { get 1(): unknown { return error; } }; Object.assign(values, { ...source, 1: 'safe' }, source); return values; }`,
    index: undefined,
    elements: ['source:0', 'source:array', "'safe':", 'source:0', 'source:array', 'error:'],
  },
  {
    id: 'define-map-hidden-then-visible',
    source: `function frames(error: Error, flag: boolean) { ${VALUES} const maps = { get 0() { return { value: error }; } }; Object.defineProperties(values, flag ? { ...maps, 0: { value: 'safe' } } : maps); return values; }`,
    index: undefined,
    elements: [
      "flag ? { ...maps, 0: { value: 'safe' } } : maps:0.value",
      'maps:0.value',
      "'safe':",
      'maps:0.value',
      'error:',
    ],
  },
  {
    id: 'define-map-later-field-hides-spread-entry',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperties(values, { ...{ 0: { value: error } }, 0: { value: 'safe' } }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'define-map-entry-after-field-hides-it',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperties(values, { 0: { value: error }, ...{ 0: { value: 'safe' } } }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'define-map-getter-then-setter-keeps-getter',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperties(values, { get 0() { return { value: error }; }, set 0(value: unknown) {} }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-map-spread-getter-then-setter-hides',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperties(values, { ...{ get 0() { return { value: error }; } }, set 0(value: unknown) {} }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'assign-call-borrowed',
    source: `function frames(error: Error) { ${VALUES} Object.assign.call(null, values, { 0: error }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'assign-apply-borrowed',
    source: `function frames(error: Error) { ${VALUES} Object.assign.apply(null, [values, { 0: error }]); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'assign-reflect-apply-borrowed',
    source: `function frames(error: Error) { ${VALUES} Reflect.apply(Object.assign, null, [values, { 0: error }]); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-call-borrowed',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty.call(null, values, 0, { value: error }); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-properties-apply-borrowed',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperties.apply(null, [values, { 0: { value: error } }]); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'assign-call-unresolved-pin',
    source: `function frames(error: Error, args: unknown[]) { ${VALUES} Object.assign.call(null, ...args); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'define-constant-getter-assigned-after-use-pin',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = {}; Object.defineProperty(values, 0, descriptor); descriptor.get = () => error; return values; }`,
    index: undefined,
    elements: ['descriptor:value'],
  },
  {
    id: 'define-constant-getter-assigned-before-use',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = {}; descriptor.get = () => error; Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', 'error:'],
  },
  {
    id: 'define-constant-getter-assigned-in-function',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = {}; function change() { descriptor.get = () => error; } change(); Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', 'error:'],
  },
  {
    id: 'define-constant-getter-assigned-later-in-loop',
    source: `function frames(error: Error, count: number) { ${VALUES} const descriptor: PropertyDescriptor = {}; for (let at = 0; at < count; at += 1) { Object.defineProperty(values, 0, descriptor); descriptor.get = () => error; } return values; }`,
    index: undefined,
    elements: ['descriptor:value', 'error:'],
  },
  {
    id: 'define-descriptor-later-field-hides-spread-field',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { ...{ value: error }, value: 'safe' }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'define-descriptor-later-value-hides-spread-getter',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { ...{ get: () => error }, get: () => 'safe' }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'define-descriptor-field-after-hides-spread',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { value: error, ...{ value: 'safe' } }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'define-descriptor-own-field-hides-prototype',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { value: 'safe', __proto__: { value: error } } as PropertyDescriptor); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'define-descriptor-prototype-keeps-other-field',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperty(values, 0, { value: 'safe', __proto__: { get: () => error } } as PropertyDescriptor); return values; }`,
    index: undefined,
    elements: ["'safe':", 'error:'],
  },
  {
    id: 'define-constant-descriptor-hidden-then-visible',
    source: `function frames(error: Error, flag: boolean) { ${VALUES} const base = { value: error }; Object.defineProperty(values, 0, flag ? { ...base, value: 'safe' } : base); return values; }`,
    index: undefined,
    elements: [
      "flag ? { ...base, value: 'safe' } : base:value",
      'base:value',
      "'safe':",
      'base:value',
      'error:',
    ],
  },
  {
    id: 'define-copies-before-and-after-write',
    source: `function frames(error: Error) { ${VALUES} const d: PropertyDescriptor = {}; const before = { ...d }; d.get = () => error; const after = { ...d }; Object.defineProperties(values, { 0: after, 1: before }); return values; }`,
    index: undefined,
    elements: ['after:value', 'd:value', 'error:', 'before:value', 'd:value'],
  },
  {
    id: 'define-constant-getter-assigned-in-unused-function-pin',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = {}; function unused() { descriptor.get = () => error; } Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value'],
  },
  {
    id: 'define-map-descriptor-assigned-in-later-field',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = {}; Object.defineProperties(values, { 0: descriptor, 1: (descriptor.get = () => error, { value: 'safe' }) }); return values; }`,
    index: undefined,
    elements: [
      'descriptor:value',
      'error:',
      "(descriptor.get = () => error, { value: 'safe' }):value",
    ],
  },
  {
    id: 'define-descriptor-assigned-in-later-argument',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = {}; Object.defineProperty(values, 0, descriptor, (descriptor.get = () => error)); return values; }`,
    index: undefined,
    elements: ['descriptor:value', 'error:'],
  },
  {
    id: 'define-map-assigned-after-declaration',
    source: `function frames(error: Error) { ${VALUES} const descriptors: PropertyDescriptorMap = {}; descriptors[0] = { get: () => error }; Object.defineProperties(values, descriptors); return values; }`,
    index: undefined,
    elements: ['descriptors:0.value', 'error:'],
  },
  {
    id: 'define-map-assigned-by-name',
    source: `function frames(error: Error) { ${VALUES} const descriptors: PropertyDescriptorMap = {}; descriptors['0'] = { value: error }; Object.defineProperties(values, descriptors); return values; }`,
    index: undefined,
    elements: ['descriptors:0.value', 'error:'],
  },
  {
    id: 'define-map-other-key-assigned-pin',
    source: `function frames(error: Error) { ${VALUES} const descriptors: PropertyDescriptorMap = {}; descriptors.label = { get: () => error }; Object.defineProperties(values, descriptors); return values; }`,
    index: undefined,
    elements: ['descriptors:0.value'],
  },
  {
    id: 'define-map-assigned-after-use-pin',
    source: `function frames(error: Error) { ${VALUES} const descriptors: PropertyDescriptorMap = {}; Object.defineProperties(values, descriptors); descriptors[0] = { get: () => error }; return values; }`,
    index: undefined,
    elements: ['descriptors:0.value'],
  },
  {
    id: 'assign-spread-tuple-sources',
    source: `function frames(error: Error, pair: [object, object]) { ${VALUES} Object.assign(values, ...pair); return values; }`,
    index: undefined,
    elements: ['pair:0.0', 'pair:1.0'],
  },
  {
    id: 'assign-spread-three-tuple-sources',
    source: `function frames(error: Error, triple: [{ 0: Error }, string, { 0: Error }]) { ${VALUES} Object.assign(values, ...triple); return values; }`,
    index: undefined,
    elements: ['triple:0.0', 'triple:1.0', 'triple:2.0'],
  },
  {
    id: 'assign-spread-list-sources-pin',
    source: `function frames(error: Error, list: object[]) { ${VALUES} Object.assign(values, ...list); return values; }`,
    index: undefined,
    elements: ['list:0.0'],
  },
  {
    id: 'define-copy-before-later-write-pin',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = {}; Object.defineProperties(values, { 0: { ...descriptor }, 1: (descriptor.get = () => error, { value: 'safe' }) }); return values; }`,
    index: undefined,
    elements: ['descriptor:value', "(descriptor.get = () => error, { value: 'safe' }):value"],
  },
  {
    id: 'define-map-write-hidden-by-later-field',
    source: `function frames(error: Error) { ${VALUES} const maps: PropertyDescriptorMap = {}; maps[0] = { get: () => error }; Object.defineProperties(values, { ...maps, 0: { value: 'safe' } }); return values; }`,
    index: undefined,
    elements: ['maps:0.value', "'safe':"],
  },
  {
    id: 'define-map-write-before-later-spread-keeps',
    source: `function frames(error: Error) { ${VALUES} const maps: PropertyDescriptorMap = {}; maps[0] = { get: () => error }; Object.defineProperties(values, { 0: { value: 'safe' }, ...maps }); return values; }`,
    index: undefined,
    elements: ["'safe':", 'maps:0.value', 'error:'],
  },
  {
    id: 'define-array-map',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperties(values, [{ get: () => error }] as unknown as PropertyDescriptorMap); return values; }`,
    index: undefined,
    elements: ['error:'],
  },
  {
    id: 'define-array-map-at-index',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperties(values, [{ value: 'a' }, { value: error }] as unknown as PropertyDescriptorMap); return values; }`,
    index: 1,
    elements: ['error:'],
  },
  {
    id: 'define-array-map-other-index-pin',
    source: `function frames(error: Error) { ${VALUES} Object.defineProperties(values, [{ value: 'a' }, { value: error }] as unknown as PropertyDescriptorMap); return values; }`,
    index: 0,
    elements: ["'a':"],
  },
  {
    id: 'define-constant-array-map',
    source: `function frames(error: Error) { ${VALUES} const maps = [{ get: () => error }] as unknown as PropertyDescriptorMap; Object.defineProperties(values, maps); return values; }`,
    index: undefined,
    elements: ['maps:0.value', 'error:'],
  },
  {
    id: 'define-destructured-descriptor-member',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = {}; [descriptor.get] = [() => error]; Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', 'error:'],
  },
  {
    id: 'define-destructured-object-descriptor-member',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = {}; ({ f: descriptor.get } = { f: () => error }); Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', 'error:'],
  },
  {
    id: 'define-loop-head-descriptor-member',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = {}; for (descriptor.get of [() => error]) { } Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', 'error:'],
  },
  {
    id: 'define-destructured-after-use-pin',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = {}; Object.defineProperty(values, 0, descriptor); [descriptor.get] = [() => error]; return values; }`,
    index: undefined,
    elements: ['descriptor:value'],
  },
  {
    id: 'define-destructured-other-member-pin',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = {}; [descriptor.enumerable] = [error]; Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value'],
  },
  {
    id: 'define-destructured-typed-path',
    source: `function frames(error: Error, holder: { item: Error }) { ${VALUES} const descriptor: PropertyDescriptor = {}; ({ item: descriptor.value } = holder); Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', 'holder:item'],
  },
  {
    id: 'define-destructured-typed-list-path',
    source: `function frames(error: Error, list: [Error]) { ${VALUES} const descriptor: PropertyDescriptor = {}; [descriptor.value] = list; Object.defineProperty(values, 0, descriptor); return values; }`,
    index: undefined,
    elements: ['descriptor:value', 'list:0'],
  },
  {
    id: 'define-descriptor-write-hidden-by-later-field',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = {}; descriptor.get = () => error; Object.defineProperty(values, 0, { ...descriptor, get: () => 'safe' }); return values; }`,
    index: undefined,
    elements: ['descriptor:value', "'safe':"],
  },
  {
    id: 'define-descriptor-write-kept-by-earlier-field',
    source: `function frames(error: Error) { ${VALUES} const descriptor: PropertyDescriptor = {}; descriptor.get = () => error; Object.defineProperty(values, 0, { get: () => 'safe', ...descriptor }); return values; }`,
    index: undefined,
    elements: ["'safe':", 'descriptor:value', 'error:'],
  },
  {
    id: 'define-async-named-getter-pin',
    source: `function frames(error: Error) { ${VALUES} async function getter() { return error; } Object.defineProperty(values, 0, { get: getter }); return values; }`,
    index: undefined,
    elements: [],
  },
  {
    id: 'assign-getter-nested-setter',
    source: `function frames(error: Error) { ${VALUES} Object.assign(values, { get 0() { let later = { set field(value: number) { return error; } }; later = later; return 'safe'; } }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
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
  {
    id: 'define-descriptor-getter-gives-this-on-before-value',
    source: `function frames(error: Error) { const values: unknown[] = ['safe']; Object.defineProperty(values, 0, { get enumerable() { Object.assign(this, { value: error }); return true; }, value: 'safe' }); return values; }`,
    index: undefined,
    elements: [
      "'safe':",
      "{ get enumerable() { Object.assign(this, { value: error }); return true; }, value: 'safe' }:value",
    ],
  },
  {
    id: 'define-descriptor-getter-gives-this-on-after-value-is-read-pin',
    source: `function frames(error: Error) { const values: unknown[] = ['safe']; Object.defineProperty(values, 0, { value: 'safe', get probe() { Object.assign(this, { value: error }); return true; } }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'define-spread-descriptor-getter-gives-this-on',
    source: `function frames(error: Error) { const values: unknown[] = ['safe']; Object.defineProperty(values, 0, { ...{ get probe() { Object.assign(this, { value: error }); return true; }, value: 'safe' } }); return values; }`,
    index: undefined,
    elements: [
      "'safe':",
      "{ get probe() { Object.assign(this, { value: error }); return true; }, value: 'safe' }:value",
    ],
  },
  {
    id: 'define-descriptor-writing-setter-gets-the-write-pin',
    source: `function frames(error: Error, key: string) { const values: unknown[] = ['safe']; Object.defineProperty(values, 0, { get enumerable() { this.writable = 1; return true; }, set writable(v: unknown) { this.value = error; } }); return values; }`,
    index: 0,
    elements: [
      '{ get enumerable() { this.writable = 1; return true; }, set writable(v: unknown) { this.value = error; } }:value',
    ],
  },
  {
    id: 'define-descriptor-spread-before-a-writing-setter',
    source: `function frames(error: Error, key: string) { const values: unknown[] = ['safe']; Object.defineProperty(values, 0, { ...{}, get enumerable() { this.writable = 1; return true; }, set writable(v: unknown) { this.value = error; } }); return values; }`,
    index: 0,
    elements: [
      '{ ...{}, get enumerable() { this.writable = 1; return true; }, set writable(v: unknown) { this.value = error; } }:value',
    ],
  },
  {
    id: 'define-descriptor-writing-setter-before-a-spread',
    source: `function frames(error: Error, key: string) { const values: unknown[] = ['safe']; Object.defineProperty(values, 0, { get enumerable() { this.writable = 1; return true; }, set writable(v: unknown) { this.value = error; }, ...{} }); return values; }`,
    index: 0,
    elements: [
      '{ get enumerable() { this.writable = 1; return true; }, set writable(v: unknown) { this.value = error; }, ...{} }:value',
    ],
  },
  {
    id: 'define-descriptor-computed-setter-may-be-the-written-field',
    source: `function frames(error: Error, key: string) { const values: unknown[] = ['safe']; Object.defineProperty(values, 0, { get enumerable() { this.writable = 1; return true; }, set [key](v: unknown) { this.value = error; } }); return values; }`,
    index: 0,
    elements: [
      '{ get enumerable() { this.writable = 1; return true; }, set [key](v: unknown) { this.value = error; } }:value',
    ],
  },
  {
    id: 'assign-getter-unknown-key-after-indices-pin',
    source: `function frames(error: Error, key: string) { const values: unknown[] = ['safe']; Object.assign(values, { get probe() { this[key] = error; return 1; }, 0: 'safe', 1: 'safe' }); return values; }`,
    index: undefined,
    elements: ["'safe':", "'safe':"],
  },
  {
    id: 'assign-getter-unknown-key-before-an-index',
    source: `function frames(error: Error, key: string) { const values: unknown[] = ['safe']; Object.assign(values, { get 0() { this[key] = error; return 'safe'; }, 1: 'safe' }); return values; }`,
    index: undefined,
    elements: ['error:', "'safe':", "'safe':"],
  },
  {
    id: 'define-map-getter-unknown-key-after-indices-pin',
    source: `function frames(error: Error, key: string) { const values: unknown[] = ['safe']; Object.defineProperties(values, { get probe() { this[key] = { value: error }; return {}; }, 0: { value: 'safe' }, 1: { value: 'safe' } }); return values; }`,
    index: undefined,
    elements: ["'safe':", "'safe':"],
  },
  {
    id: 'define-map-getter-unknown-key-before-an-index',
    source: `function frames(error: Error, key: string) { const values: unknown[] = ['safe']; Object.defineProperties(values, { get 0() { this[key] = { value: error }; return { value: 'safe' }; }, 1: { value: 'safe' } }); return values; }`,
    index: undefined,
    elements: ['error:', "'safe':", "'safe':"],
  },
  {
    id: 'assign-getter-gives-this-on-before-an-index',
    source: `function frames(error: Error) { const values: unknown[] = ['safe']; Object.assign(values, { get 0() { Object.assign(this, { 1: error }); return 'safe'; }, 1: 'safe' }); return values; }`,
    index: undefined,
    elements: [
      "{ get 0() { Object.assign(this, { 1: error }); return 'safe'; }, 1: 'safe' }:0",
      "'safe':",
      "'safe':",
    ],
  },
  {
    id: 'assign-getter-gives-this-on-after-the-slot-pin',
    source: `function frames(error: Error) { const values: unknown[] = ['safe']; Object.assign(values, { 0: 'safe', get 1() { Object.assign(this, { 0: error }); return 'safe'; } }); return values; }`,
    index: 0,
    elements: ["'safe':"],
  },
  {
    id: 'assign-getter-gives-this-on-named-pin',
    source: `function frames(error: Error) { const values: unknown[] = ['safe']; Object.assign(values, { get probe() { Object.assign(this, { 0: error }); return 1; }, 0: 'safe' }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'define-map-getter-gives-this-on-before-an-index',
    source: `function frames(error: Error) { const values: unknown[] = ['safe']; Object.defineProperties(values, { get 0() { Object.assign(this, { 1: { value: error } }); return { value: 'safe' }; }, 1: { value: 'safe' } }); return values; }`,
    index: undefined,
    elements: [
      "{ get 0() { Object.assign(this, { 1: { value: error } }); return { value: 'safe' }; }, 1: { value: 'safe' } }:0.value",
      "'safe':",
      "'safe':",
    ],
  },
  {
    id: 'assign-getter-writes-a-key-the-source-lacks-pin',
    source: `function frames(error: Error, key: '1' | '2') { const values: unknown[] = ['safe']; Object.assign(values, { get 0() { this[1] = error; return 'safe'; } }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'define-map-getter-writes-a-key-the-map-lacks-pin',
    source: `function frames(error: Error, key: '1' | '2') { const values: unknown[] = ['safe']; Object.defineProperties(values, { get 0() { this[1] = { value: error }; return { value: 'safe' }; } }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'assign-getter-writes-an-accessor-slot-pin',
    source: `function frames(error: Error, key: '1' | '2') { const values: unknown[] = ['safe']; Object.assign(values, { get 0() { this[1] = error; return 'safe'; }, get 1() { return 'safe'; }, set 1(value: unknown) {} }); return values; }`,
    index: undefined,
    elements: ["'safe':", "'safe':"],
  },
  {
    id: 'define-map-getter-writes-an-accessor-slot-pin',
    source: `function frames(error: Error, key: '1' | '2') { const values: unknown[] = ['safe']; Object.defineProperties(values, { get 0() { this[1] = { value: error }; return { value: 'safe' }; }, get 1() { return { value: 'safe' }; }, set 1(value: unknown) {} }); return values; }`,
    index: undefined,
    elements: ["'safe':", "'safe':"],
  },
  {
    id: 'assign-getter-writes-a-slot-whose-setter-writes',
    source: `function frames(error: Error, key: '1' | '2') { const values: unknown[] = ['safe']; Object.assign(values, { get 0() { this[1] = 0; return 'safe'; }, get 1() { return 'safe'; }, set 1(value: unknown) { this[2] = error; }, 2: 'safe' }); return values; }`,
    index: undefined,
    elements: [
      "{ get 0() { this[1] = 0; return 'safe'; }, get 1() { return 'safe'; }, set 1(value: unknown) { this[2] = error; }, 2: 'safe' }:0",
      "'safe':",
      "'safe':",
      "'safe':",
    ],
  },
  {
    id: 'assign-getter-runs-a-named-setter-that-writes',
    source: `function frames(error: Error, key: '1' | '2') { const values: unknown[] = ['safe']; Object.assign(values, { get 0() { this.activate = 0; return 'safe'; }, set activate(value: unknown) { this[1] = error; }, 1: 'safe' }); return values; }`,
    index: undefined,
    elements: [
      "{ get 0() { this.activate = 0; return 'safe'; }, set activate(value: unknown) { this[1] = error; }, 1: 'safe' }:0",
      "'safe':",
      "'safe':",
    ],
  },
  {
    id: 'assign-getter-write-in-a-dead-branch-pin',
    source: `function frames(error: Error, key: '1' | '2') { const values: unknown[] = ['safe']; Object.assign(values, { get 0() { if (false) this[1] = error; return 'safe'; }, 1: 'safe' }); return values; }`,
    index: undefined,
    elements: ["'safe':", "'safe':"],
  },
  {
    id: 'assign-getter-write-in-a-live-branch',
    source: `function frames(error: Error, key: '1' | '2') { const values: unknown[] = ['safe']; Object.assign(values, { get 0() { if (true) this[1] = error; return 'safe'; }, 1: 'safe' }); return values; }`,
    index: undefined,
    elements: ['error:', "'safe':", "'safe':"],
  },
  {
    id: 'assign-getter-computed-write-overwritten-pin',
    source: `function frames(error: Error, key: '1' | '2') { const values: unknown[] = ['safe']; Object.assign(values, { ...{ get 0() { this[key] = error; return 'safe'; }, 1: 'safe', 2: 'safe' }, 1: 'kept', 2: 'kept' }); return values; }`,
    index: 1,
    elements: ["'kept':"],
  },
  {
    id: 'assign-getter-computed-write-not-overwritten',
    source: `function frames(error: Error, key: '1' | '2') { const values: unknown[] = ['safe']; Object.assign(values, { ...{ get 0() { this[key] = error; return 'safe'; }, 1: 'safe', 2: 'safe' }, 1: 'kept' }); return values; }`,
    index: 1,
    elements: ["'kept':"],
  },
  {
    id: 'assign-symbol-getter-writes-a-slot-pin',
    source: `function frames(error: Error, name: string) { const values: unknown[] = ['safe']; Object.assign(values, { get [Symbol.iterator]() { this[1] = error; return 'safe'; }, 1: 'safe' }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'assign-symbol-getter-gives-this-on-pin',
    source: `function frames(error: Error, name: string) { const values: unknown[] = ['safe']; Object.assign(values, { get [Symbol.iterator]() { Object.assign(this, { 1: error }); return 'safe'; }, 1: 'safe' }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'define-map-symbol-getter-writes-a-slot-pin',
    source: `function frames(error: Error, name: string) { const values: unknown[] = ['safe']; Object.defineProperties(values, { get [Symbol.iterator]() { this[1] = { value: error }; return { value: 'safe' }; }, 1: { value: 'safe' } }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'assign-computed-getter-writes-a-slot',
    source: `function frames(error: Error, name: string) { const values: unknown[] = ['safe']; Object.assign(values, { get [name]() { this[1] = error; return 'safe'; }, 1: 'safe' }); return values; }`,
    index: undefined,
    elements: ['error:', "'safe':", "'safe':"],
  },
  {
    id: 'assign-spread-before-an-accessor-pair-hides-the-write',
    source: `function frames(error: Error, name: string) { const values: unknown[] = ['safe']; Object.assign(values, { ...{}, get 0() { this[1] = error; return 'safe'; }, get 1() { return 'safe'; }, set 1(value: unknown) {} }); return values; }`,
    index: 1,
    elements: ["'safe':"],
  },
  {
    id: 'assign-symbol-length-getter-writes-a-slot',
    source: `function frames(error: Error, name: string) { const values: unknown[] = ['safe']; Object.assign(values, { get [Symbol.length]() { this[1] = error; return 'safe'; }, 1: 'safe' }); return values; }`,
    index: undefined,
    elements: ['error:', "'safe':", "'safe':"],
  },
  {
    id: 'assign-symbol-call-getter-writes-no-slot',
    source: `function frames(error: Error, name: string) { const values: unknown[] = ['safe']; Object.assign(values, { get [Symbol('label')]() { this[1] = error; return 'safe'; }, 1: 'safe' }); return values; }`,
    index: undefined,
    elements: ["'safe':"],
  },
  {
    id: 'assign-spread-before-a-writing-setter',
    source: `function frames(error: Error, name: string) { const values: unknown[] = ['safe']; Object.assign(values, { ...{}, get 0() { this.field = 1; return 'safe'; }, set field(value: unknown) { this[1] = error; }, 1: 'safe' }); return values; }`,
    index: 1,
    elements: [
      "{ ...{}, get 0() { this.field = 1; return 'safe'; }, set field(value: unknown) { this[1] = error; }, 1: 'safe' }:1",
      "'safe':",
    ],
  },
  {
    id: 'assign-writing-setter-before-a-spread',
    source: `function frames(error: Error, name: string) { const values: unknown[] = ['safe']; Object.assign(values, { get 0() { this.field = 1; return 'safe'; }, set field(value: unknown) { this[1] = error; }, ...{}, 1: 'safe' }); return values; }`,
    index: 1,
    elements: [
      "{ get 0() { this.field = 1; return 'safe'; }, set field(value: unknown) { this[1] = error; }, ...{}, 1: 'safe' }:1",
      "'safe':",
    ],
  },
  {
    id: 'assign-computed-writing-setter-may-be-the-field',
    source: `function frames(error: Error, name: string) { const values: unknown[] = ['safe']; Object.assign(values, { get 0() { this.field = 1; return 'safe'; }, set [name](value: unknown) { this[1] = error; }, 1: 'safe' }); return values; }`,
    index: 1,
    elements: [
      "{ get 0() { this.field = 1; return 'safe'; }, set [name](value: unknown) { this[1] = error; }, 1: 'safe' }:1",
      "'safe':",
    ],
  },
  {
    id: 'assign-getter-logical-write-to-a-slot-holding-a-value-pin',
    source: `function frames(error: Error, name: string) { const values: unknown[] = ['safe']; Object.assign(values, { get 0() { this[1] ??= error; return 'safe'; }, 1: 'safe' }); return values; }`,
    index: 1,
    elements: ['error:', "'safe':"],
  },
  {
    id: 'define-map-getter-logical-write-to-a-slot-holding-a-value-pin',
    source: `function frames(error: Error, name: string) { const values: unknown[] = ['safe']; Object.defineProperties(values, { get 0() { this[1] ??= { value: error }; return { value: 'safe' }; }, 1: { value: 'safe' } }); return values; }`,
    index: 1,
    elements: ['error:', "'safe':"],
  },
] as const;

describe('descriptors built from constants that spread each other', () => {
  it('are read in work that grows with the declarations, not with the copies', () => {
    const levels = Array.from(
      { length: 40 },
      (_, at) => `const d${at + 1} = { ...d${at}, ...d${at} };`,
    ).join(' ');
    const source = `function frames(error: Error) { ${VALUES} const d0 = { value: error }; ${levels} Object.defineProperty(values, 0, d40); return values; }`;
    const found = writtenElements(source, undefined);

    expect(found).toContain('error:');
    expect(found.length).toBeLessThan(100);
  });
});

describe('sources built from constants that spread each other', () => {
  it('are read in work that grows with the declarations, not with the copies', () => {
    const levels = Array.from(
      { length: 40 },
      (_, at) => `const s${at + 1} = { ...s${at}, ...s${at} };`,
    ).join(' ');
    const source = `function frames(error: Error) { ${VALUES} const s0 = { 0: error }; ${levels} Object.assign(values, s40); return values; }`;
    const found = writtenElements(source, undefined);

    expect(found).toContain('error:');
    expect(found.length).toBeLessThan(200);
  });
});

describe('sources built from conditions that spread each other', () => {
  it('are read in work that does not grow with the paths through them', () => {
    const levels = Array.from(
      { length: 30 },
      (_, at) =>
        `const s${at + 1} = flag ? { ...s${at}, ${2 * at + 3}: 'safe' } : { ...s${at}, ${2 * at + 4}: 'safe' };`,
    ).join(' ');
    const source = `function frames(error: Error, flag: boolean) { ${VALUES} const s0 = { 0: error }; ${levels} Object.assign(values, s30); return values; }`;
    const found = writtenElements(source, undefined);

    expect(found).toContain('error:');
    expect(found.length).toBeLessThan(2000);
  });
});

describe('a source read under names several overwrites hide', () => {
  it('keeps the names every one of them hides', () => {
    const copies = [1, 2, 3, 4, 5, 6]
      .map((key) => `{ ...source, 0: 'safe', ${key}: 'safe' }`)
      .join(', ');
    const source = `function frames(error: Error) { ${VALUES} const source = { get 0() { return error; } }; Object.assign(values, ${copies}); return values; }`;

    expect(writtenElements(source, undefined)).not.toContain('error:');
  });
});

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
    id: 'assign-getter-nested-setter-converts',
    source: `function frames(error: Error) { const a = ['plain']; Object.assign(a, { get 0() { let later = { set field(value: number) { return error; } }; later = later; return 'safe'; } }); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-explicit-key-spread-converts',
    source: `function frames(error: Error, descriptors: PropertyDescriptor[]) { const a = ['safe']; Object.defineProperty(a, 0, ...descriptors, { value: error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-descriptor-spread-getter-converts',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperty(a, 0, { ...{ get: () => error } }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-constant-key-safe',
    source: `function frames(error: Error) { const a = ['safe']; const key = 'label'; Object.defineProperty(a, key, { value: error }); return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-constant-computed-key-safe',
    source: `function frames(error: Error) { const a = ['safe']; const key = 'label'; Object.assign(a, { [key]: error }); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-constant-index-key-converts',
    source: `function frames(error: Error) { const a = ['safe']; const key = 0; Object.defineProperty(a, key, { value: error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-descriptor-proto-converts',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperty(a, 0, { __proto__: { value: error }, configurable: true } as PropertyDescriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-spread-target-converts',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(...[a] as const, { 0: error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-spread-target-converts',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperty(...[a, 0] as const, { value: error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-constant-map-getter-converts',
    source: `function frames(error: Error) { const a = ['safe']; const descriptors = { 0: { get: () => error } }; Object.defineProperties(a, descriptors); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-spread-property-getter-converts',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { ...{ get 0() { return error; } } }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-reassigned-getter-converts',
    source: `function frames(error: Error) { const a = ['safe']; function getter(): unknown { return 'safe'; } getter = () => error; Object.defineProperty(a, 0, { get: getter }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-overloaded-getter-converts',
    source: `function frames(error: Error) { const a = ['safe']; function getter(): string; function getter(): unknown { return error; } Object.defineProperty(a, 0, { get: getter }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-repeated-constant-list-safe',
    source: `function frames(error: Error) { const a = ['safe']; const empty: never[] = []; Object.defineProperty(a, ...empty, ...empty, 'label', { value: error }); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-descriptor-spread-prototype-safe',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperty(a, 0, { ...{ __proto__: { value: error } } } as PropertyDescriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-conditional-getter-converts',
    source: `function frames(error: Error, flag: boolean) { const a = ['safe']; Object.defineProperty(a, 0, { get: flag ? () => error : () => 'safe' }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-constant-getter-assigned-converts',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; descriptor.get = () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-reassigned-alias-write-refused-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; let alias = descriptor; alias = {}; alias.get = () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-conditional-descriptor-converts',
    source: `function frames(error: Error, flag: boolean) { const a = ['safe']; Object.defineProperty(a, 0, flag ? { get: () => error } : {}); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-conditional-source-converts',
    source: `function frames(error: Error, flag: boolean) { const a = ['safe']; Object.assign(a, flag ? { 0: error } : {}); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-constant-conditional-descriptor-assigned-converts',
    source: `function frames(error: Error, flag: boolean) { const a = ['safe']; const descriptor: PropertyDescriptor = flag ? { get: () => 'safe' } : {}; descriptor.get = () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-getter-reference-after-alias-converts',
    source: `function frames(error: Error, flag: boolean) { const a = ['safe']; function f(): unknown { return 'safe'; } const alias = f; f = () => error; Object.defineProperty(a, 0, { get: flag ? alias : f }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-let-alias-write-converts',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; let alias = descriptor; alias.get = () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-constant-getter-source-converts',
    source: `function frames(error: Error) { const a = ['safe']; const source = { get 0(): unknown { return error; } }; Object.assign(a, source); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-constant-computed-other-field-safe',
    source: `function frames(error: Error) { const a = ['safe']; const key = 'metadata'; const descriptor: PropertyDescriptor = { [key]: error, configurable: true }; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-constant-getter-logical-assigned-converts',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: undefined }; descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-short-circuited-source-safe',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, false && { 0: error }); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-symbol-key-safe',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperty(a, Symbol.iterator, { value: error }); return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-symbol-computed-key-safe',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { [Symbol.iterator]: error }); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-nullish-constant-getter-converts',
    source: `function frames(error: Error) { const a = ['safe']; const empty = null; Object.defineProperty(a, 0, { get: empty ?? (() => error) }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-key-for-key-converts',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { [Symbol.keyFor(Symbol.for('0'))!]: error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-chained-target-converts',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(Object.assign(a, {}), { 0: error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-reassigned-function-nullish-getter-converts',
    source: `function frames(error: Error) { const a = ['safe']; function getter(): unknown { return 'safe'; } getter = undefined!; Object.defineProperty(a, 0, { get: getter ?? (() => error) }); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-overwritten-spread-entry-safe',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { ...{ 0: error }, 0: 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-map-overwritten-entry-safe',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperties(a, { ...{ 0: { value: error } }, 0: { value: 'safe' } }); return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-call-borrowed-converts',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign.call(null, a, { 0: error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-constant-getter-assigned-after-use-safe',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; Object.defineProperty(a, 0, descriptor); descriptor.get = () => error; return String(a); }`,
    converts: false,
  },
  {
    id: 'define-descriptor-overwritten-field-safe',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperty(a, 0, { ...{ value: error }, value: 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-copies-before-and-after-write-converts',
    source: `function frames(error: Error) { const a = ['safe']; const d: PropertyDescriptor = {}; const before = { ...d }; d.get = () => error; const after = { ...d }; Object.defineProperties(a, { 0: after, 1: before }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-map-descriptor-assigned-in-later-field-converts',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; Object.defineProperties(a, { 0: descriptor, 1: (descriptor.get = () => error, { value: 'safe' }) }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-descriptor-assigned-in-unused-function-safe',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; function unused() { descriptor.get = () => error; } Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-map-assigned-after-declaration-converts',
    source: `function frames(error: Error) { const a = ['safe']; const descriptors: PropertyDescriptorMap = {}; descriptors[0] = { get: () => error }; Object.defineProperties(a, descriptors); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-array-map-converts',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperties(a, [{ get: () => error }] as unknown as PropertyDescriptorMap); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-destructured-descriptor-member-converts',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; [descriptor.get] = [() => error]; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-copy-before-later-write-safe',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; Object.defineProperties(a, { 0: { ...descriptor }, 1: (descriptor.get = () => error, { value: 'safe' }) }); return String(a); }`,
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
  {
    id: 'define-descriptor-alias-in-loop-converts',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { configurable: true }; for (let at = 0; at < 2; at += 1) { const alias = descriptor; Object.defineProperty(a, 0, alias); descriptor.get = () => error; } return String(a); }`,
    converts: true,
  },
  {
    id: 'define-descriptor-alias-declared-in-loop-safe',
    source: `function frames(error: Error) { const a = ['safe']; for (let at = 0; at < 2; at += 1) { const descriptor: PropertyDescriptor = { configurable: true }; const alias = descriptor; Object.defineProperty(a, 0, alias); descriptor.get = () => error; } return String(a); }`,
    converts: false,
  },
  {
    id: 'define-descriptor-alias-chain-in-loop-converts',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { configurable: true }; const first = descriptor; for (let at = 0; at < 2; at += 1) { const second = first; Object.defineProperty(a, 0, second); descriptor.get = () => error; } return String(a); }`,
    converts: true,
  },
  {
    id: 'define-array-map-spread-literal-converts',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperties(a, [{ value: 'a' }, ...[{ get: () => error }]] as unknown as PropertyDescriptorMap); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-array-map-spread-first-converts',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperties(a, [...[{ get: () => error }]] as unknown as PropertyDescriptorMap); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-array-map-spread-constant-converts',
    source: `function frames(error: Error) { const a = ['safe']; const maps = [{ get: () => error }]; Object.defineProperties(a, [...maps] as unknown as PropertyDescriptorMap); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-array-map-spread-tuple-converts',
    source: `function frames(error: Error) { const a = ['safe']; const maps: [PropertyDescriptor, PropertyDescriptor] = [{ value: 'a' }, { get: () => error }]; Object.defineProperties(a, [...maps] as unknown as PropertyDescriptorMap); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-array-map-spread-assigned-converts',
    source: `function frames(error: Error) { const a = ['safe']; const maps: PropertyDescriptor[] = []; maps[0] = { get: () => error }; Object.defineProperties(a, [...maps] as unknown as PropertyDescriptorMap); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-array-map-spread-safe',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperties(a, [...[{ value: 'safe' }]] as unknown as PropertyDescriptorMap); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-array-map-spread-cycle-terminates',
    source: `function frames(error: Error) { const a = ['safe']; const first: PropertyDescriptor[] = [{ get: () => error }, ...second]; const second: PropertyDescriptor[] = [...first, ...first]; Object.defineProperties(a, [...first, ...second] as unknown as PropertyDescriptorMap); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-key-shorthand-getter',
    source: `function frames(error: Error, key: string) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const getter = () => error; ({ [key]: descriptor.get } = { getter }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-key-shorthand-value',
    source: `function frames(error: Error, key: string) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; ({ [key]: descriptor.value } = { error }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-key-shorthand-safe',
    source: `function frames(error: Error, key: string) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const item = 'safe'; ({ [key]: descriptor.value } = { item }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-held-list-getter',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const functions = [() => error]; [descriptor.get] = functions; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-held-object-getter',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const source = { f: () => error }; ({ f: descriptor.get } = source); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-held-list-position-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const functions = [() => 'safe', () => error]; [descriptor.get] = functions; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-held-nested-getter',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const source = { x: [() => error] }; ({ x: [descriptor.get] } = source); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-condition-source-getter',
    source: `function frames(error: Error, flag: boolean) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; [descriptor.get] = flag ? [() => error] : [() => 'safe']; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-spread-source-getter',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; ({ f: descriptor.get } = { ...{ f: () => error } }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-spread-source-hidden-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; ({ f: descriptor.get } = { ...{ f: () => error }, f: () => 'safe' }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-selected-field-is-no-error',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; ({ message: descriptor.value } = error); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-selected-element-is-no-error',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; [descriptor.value] = error as unknown as unknown[]; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-rest-object-is-no-error',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; ({ ...descriptor.value } = { item: error }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-rest-list-holds-error',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; [...descriptor.value] = [error]; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-rest-object-map-entry',
    source: `function frames(error: Error) { const a = ['safe']; const maps: PropertyDescriptorMap = {}; ({ ...maps[0] } = { get: () => error }); Object.defineProperties(a, maps); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-pattern-default-skipped-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; [descriptor.get = () => error] = [{} as never]; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-pattern-default-used',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; [descriptor.get = () => error] = []; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-pattern-default-maybe-used',
    source: `function frames(error: Error, list: (() => string)[]) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; [descriptor.get = () => error] = list; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-object-default-skipped-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; ({ f: descriptor.get = () => error } = { f: {} as never }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'getter-dead-branch-return',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { get 0() { let value = 'safe'; value += '!'; if (false) return error; return value; } }); return String(a); }`,
    converts: false,
  },
  {
    id: 'getter-live-branch-return',
    source: `function frames(error: Error, flag: boolean) { const a = ['safe']; Object.assign(a, { get 0() { let value = 'safe'; value += '!'; if (flag) return error; return value; } }); return String(a); }`,
    converts: true,
  },
  {
    id: 'getter-else-dead-branch-return',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { get 0() { let value = 'safe'; value += '!'; if (true) { return value; } else { return error; } } }); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-map-spread-list-hidden-by-later-field',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperties(a, { ...[{ get: () => error }], 0: { value: 'safe' } }); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-map-spread-list-before-field-keeps',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperties(a, { 0: { value: 'safe' }, ...[{ get: () => error }] }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-map-spread-list-other-field-keeps',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperties(a, { ...[{ get: () => error }], 1: { value: 'safe' } }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-map-spread-list-second-entry-hidden',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperties(a, { ...[{ value: 'safe' }, { get: () => error }], 1: { value: 'safe' } }); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-map-spread-constant-list-hidden',
    source: `function frames(error: Error) { const a = ['safe']; const list = [{ get: () => error }]; Object.defineProperties(a, { ...list, 0: { value: 'safe' } }); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-copy-of-list-reference-then-write',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; Object.defineProperties(a, { ...[descriptor], 1: (descriptor.get = () => error, { value: 'safe' }) }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-copy-of-condition-then-write',
    source: `function frames(error: Error, flag: boolean) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; Object.defineProperties(a, { 0: { ...(flag ? descriptor : {}) }, 1: (descriptor.get = () => error, { value: 'safe' }) }); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-key-held-list-getter',
    source: `function frames(error: Error, key: string) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const functions = [() => 'safe', () => error]; ({ [key]: descriptor.get } = functions); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-key-held-object-getter',
    source: `function frames(error: Error, key: string) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const source = { f: () => error }; ({ [key]: descriptor.get } = source); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-key-condition-getter',
    source: `function frames(error: Error, key: string, flag: boolean) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; ({ [key]: descriptor.get } = flag ? { f: () => error } : {}); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-key-spread-source-getter',
    source: `function frames(error: Error, key: string) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const source = { ...{ f: () => error } }; ({ [key]: descriptor.get } = source); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-key-held-safe-pin',
    source: `function frames(error: Error, key: string) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const source = { f: () => 'safe' }; ({ [key]: descriptor.get } = source); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-key-literal-spread-getter',
    source: `function frames(error: Error, key: string) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; ({ [key]: descriptor.get } = { ...{ f: () => error } }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-key-list-spread-getter',
    source: `function frames(error: Error, key: string) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const functions = [() => error]; ({ [key]: descriptor.get } = [...functions]); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-key-literal-spread-safe-pin',
    source: `function frames(error: Error, key: string) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; ({ [key]: descriptor.get } = { ...{ f: () => 'safe' } }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-key-literal-accessor-getter',
    source: `function frames(error: Error, key: string) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; ({ [key]: descriptor.get } = { get f() { return () => error; } }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-key-literal-accessor-value',
    source: `function frames(error: Error, key: string) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; ({ [key]: descriptor.value } = { get f() { return error; } }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-key-literal-accessor-safe-pin',
    source: `function frames(error: Error, key: string) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; ({ [key]: descriptor.value } = { get f() { return 'safe'; } }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'src-getter-setter-pair',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; ({ f: descriptor.get } = { get f() { return () => error; }, set f(value: unknown) {} }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-setter-getter-pair',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; ({ f: descriptor.get } = { set f(value: unknown) {}, get f() { return () => error; } }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-setter-hides-data-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; ({ f: descriptor.get } = { f: () => error, set f(value: unknown) {} }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'src-data-after-setter',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; ({ f: descriptor.get } = { set f(value: unknown) {}, f: () => error }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-data-after-getter-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; ({ f: descriptor.get } = { get f() { return () => error; }, f: () => 'safe' }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'src-data-after-getter-setter-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; ({ f: descriptor.get } = { get f() { return () => error; }, set f(value: unknown) {}, f: () => 'safe' }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'src-held-getter-setter-pair',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const source = { get f() { return () => error; }, set f(value: unknown) {} }; ({ f: descriptor.get } = source); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-held-proto',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const source = { __proto__: { f: () => error } }; ({ f: descriptor.get } = source); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-held-proto-own-wins-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const source = { __proto__: { f: () => error }, f: () => 'safe' }; ({ f: descriptor.get } = source); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'src-held-proto-chain',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const base = { f: () => error }; const middle = { __proto__: base }; const source = { __proto__: middle }; ({ f: descriptor.get } = source); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-held-proto-computed-is-own-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const source = { ['__proto__']: { f: () => error } }; ({ f: descriptor.get } = source); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'src-list-spread-first',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const functions = [() => error]; [descriptor.get] = [...functions]; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-held-list-spread-first',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const functions = [() => error]; const source = [...functions]; [descriptor.get] = source; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-list-spread-then',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; [, descriptor.get] = [() => 'safe', ...[() => error]]; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-list-spread-shift',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; [descriptor.get] = [...[], () => error]; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-list-before-spread-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; [descriptor.get] = [() => 'safe', ...[() => error]]; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'src-list-spread-safe',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; [descriptor.get] = [...[() => 'safe']]; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'src-comma',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; [descriptor.get] = (0, [() => error]); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-assignment',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; let copy: unknown; [descriptor.get] = (copy = [() => error]); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-doubling-spreads-terminate',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const a0 = { f: () => error }; const a1 = { ...a0, ...a0 }; const a2 = { ...a1, ...a1 }; const a3 = { ...a2, ...a2 }; const a4 = { ...a3, ...a3 }; const a5 = { ...a4, ...a4 }; const a6 = { ...a5, ...a5 }; const a7 = { ...a6, ...a6 }; const a8 = { ...a7, ...a7 }; const a9 = { ...a8, ...a8 }; const a10 = { ...a9, ...a9 }; const a11 = { ...a10, ...a10 }; const a12 = { ...a11, ...a11 }; const a13 = { ...a12, ...a12 }; const a14 = { ...a13, ...a13 }; const a15 = { ...a14, ...a14 }; const a16 = { ...a15, ...a15 }; const a17 = { ...a16, ...a16 }; const a18 = { ...a17, ...a17 }; const a19 = { ...a18, ...a18 }; const a20 = { ...a19, ...a19 }; ({ f: descriptor.get } = a20); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-held-map-written-after-construction',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const maps = { 0: descriptor }; descriptor.get = () => error; Object.defineProperties(a, maps); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-held-map-written-after-use-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const maps = { 0: descriptor }; Object.defineProperties(a, maps); descriptor.get = () => error; return String(a); }`,
    converts: false,
  },
  {
    id: 'define-held-map-copy-before-write-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const maps = { 0: { ...descriptor } }; descriptor.get = () => error; Object.defineProperties(a, maps); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-held-list-written-after-construction',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const maps = [descriptor]; descriptor.get = () => error; Object.defineProperties(a, maps); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-held-map-alias-written-after-construction',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const alias = descriptor; const maps = { 0: alias }; descriptor.get = () => error; Object.defineProperties(a, maps); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-rest-excludes-named-fields',
    source: `function frames(error: Error) { const a = ['safe']; const maps: PropertyDescriptorMap = {}; let ignored: unknown; ({ get: ignored, ...maps[0] } = { get: () => error, value: 'safe' }); Object.defineProperties(a, maps); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-rest-keeps-other-fields',
    source: `function frames(error: Error) { const a = ['safe']; const maps: PropertyDescriptorMap = {}; let ignored: unknown; ({ value: ignored, ...maps[0] } = { get: () => error, value: 'safe' }); Object.defineProperties(a, maps); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-rest-unknown-exclusion-keeps',
    source: `function frames(error: Error, key: string) { const a = ['safe']; const maps: PropertyDescriptorMap = {}; let ignored: unknown; ({ [key]: ignored, ...maps[0] } = { get: () => error }); Object.defineProperties(a, maps); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-key-selects-no-receiver',
    source: `function frames(error: Error, key: 'message' | 'name') { const a = ['safe']; const descriptor: PropertyDescriptor = {}; ({ [key]: descriptor.value } = error); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-key-finite-excludes-field',
    source: `function frames(error: Error, key: 'g' | 'h') { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const source = { f: () => error, g: () => 'safe' }; ({ [key]: descriptor.get } = source); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-key-finite-includes-field',
    source: `function frames(error: Error, key: 'f' | 'g') { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const source = { f: () => error, g: () => 'safe' }; ({ [key]: descriptor.get } = source); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-star-key-is-no-wildcard',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const source = { '*': 'safe', other: error }; ({ '*': descriptor.value } = source); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-star-key-any-field',
    source: `function frames(error: Error, key: string) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; ({ [key]: descriptor.value } = { '*': error }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-spread-copy-skips-prototype',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const base = { __proto__: { f: () => error } }; ({ f: descriptor.get } = { ...base }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'src-spread-inline-prototype-skipped',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; ({ f: descriptor.get } = { ...{ __proto__: { f: () => error } } }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'src-spread-copy-own-field-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const base = { f: () => error }; ({ f: descriptor.get } = { ...base }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-spread-copy-keeps-own-of-prototyped',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const base = { __proto__: { g: 1 }, f: () => error }; ({ f: descriptor.get } = { ...base }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-rest-copy-before-later-write',
    source: `function frames(error: Error) { const a = ['safe']; const source: PropertyDescriptor = {}; const maps: PropertyDescriptorMap = {}; ({ ...maps[0] } = source); source.get = () => error; Object.defineProperties(a, maps); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-rest-copy-after-earlier-write-pin',
    source: `function frames(error: Error) { const a = ['safe']; const source: PropertyDescriptor = {}; const maps: PropertyDescriptorMap = {}; source.get = () => error; ({ ...maps[0] } = source); Object.defineProperties(a, maps); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-rest-copy-own-fields-only',
    source: `function frames(error: Error) { const a = ['safe']; const maps: PropertyDescriptorMap = {}; ({ ...maps[0] } = { __proto__: { get: () => error }, value: 'safe' }); Object.defineProperties(a, maps); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-rest-copy-held-prototype-pin',
    source: `function frames(error: Error) { const a = ['safe']; const maps: PropertyDescriptorMap = {}; const source = { __proto__: { get: () => error } }; ({ ...maps[0] } = source); Object.defineProperties(a, maps); return String(a); }`,
    converts: false,
  },
  {
    id: 'src-list-spread-written-length',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const source = [...[() => 'safe', () => error]]; [descriptor.get] = source; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'src-list-spread-written-second',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; [, descriptor.get] = [...[() => 'safe', () => error]]; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-list-spread-empty-first',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; [descriptor.get] = [...[], ...[() => 'safe'], () => error]; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'src-list-spread-nested-length',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; [, descriptor.get] = [...[...[() => 'safe'], () => error]]; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-list-unknown-spread-keeps',
    source: `function frames(error: Error, list: (() => string)[]) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; [descriptor.get] = [...list, () => error]; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-list-unknown-spread-after-written',
    source: `function frames(error: Error, list: (() => string)[]) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; [descriptor.get] = [() => 'safe', ...list, () => error]; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'src-list-held-spread-length',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const functions = [() => 'safe', () => error]; const source = [...functions]; [descriptor.get] = source; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-array-rest-suffix-skips-excluded',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; let ignored: unknown; [ignored, ...descriptor.value] = [error, 'safe']; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-array-rest-suffix-keeps-error',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; let ignored: unknown; [ignored, ...descriptor.value] = ['safe', error]; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-array-rest-suffix-after-spread',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; let ignored: unknown; [ignored, ...descriptor.value] = [...[error], 'safe']; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-array-rest-suffix-of-held-list',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; let ignored: unknown; const source = [error, 'safe']; [ignored, ...descriptor.value] = source; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-array-rest-suffix-of-unknown-list',
    source: `function frames(error: Error, list: unknown[]) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; let ignored: unknown; [ignored, ...descriptor.value] = list; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-logical-nullish-skipped',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-logical-or-skipped',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; descriptor.get ||= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-logical-and-skipped',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: undefined }; descriptor.get &&= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-logical-nullish-runs-on-missing',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-nullish-runs-on-undefined',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: undefined }; descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-and-runs-on-function',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; descriptor.get &&= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-or-runs-on-null',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: null as never }; descriptor.get ||= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-after-other-write-pin',
    source: `function frames(error: Error, flag: boolean) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; descriptor.get = flag ? undefined : () => 'safe'; descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-after-delete-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; delete descriptor.get; descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-spread-initial-pin',
    source: `function frames(error: Error, initial: PropertyDescriptor) { const a = ['safe']; const descriptor: PropertyDescriptor = { ...initial }; descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-other-key-skipped',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; descriptor.value = 'x'; descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-array-rest-is-no-getter',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; [...descriptor.get] = [() => error]; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-array-rest-suffix-is-no-getter',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; let ignored: unknown; [ignored, ...descriptor.get] = [() => 'safe', () => error]; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-array-rest-is-no-descriptor',
    source: `function frames(error: Error) { const a = ['safe']; const maps: PropertyDescriptorMap = {}; [...maps[0]] = [{ get: () => error }]; Object.defineProperties(a, maps); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-array-rest-keeps-value-error',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; [...descriptor.value] = [error]; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-array-rest-keeps-unknown-member',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const key = ['value'][0] as 'value'; [...descriptor[key]] = [error]; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-rest-copy-of-error-is-no-error',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; ({ ...descriptor.value } = error); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-rest-copy-of-list-is-no-error',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; ({ ...descriptor.value } = [error]); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-rest-copy-unknown-member-is-no-error',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const key = ['value'][0] as 'value'; ({ ...descriptor[key] } = { item: error }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-source-populated-after-declaration',
    source: `function frames(error: Error) { const a = ['safe']; const source: Record<number, unknown> = {}; source[1] = error; Object.assign(a, source); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-source-populated-at-the-slot',
    source: `function frames(error: Error) { const a = ['safe']; const source: Record<number, unknown> = {}; source[0] = error; Object.assign(a, source); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-source-populated-by-pattern',
    source: `function frames(error: Error) { const a = ['safe']; const source: Record<number, unknown> = {}; [source[1]] = [error]; Object.assign(a, source); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-source-populated-in-condition-pin',
    source: `function frames(error: Error, flag: boolean) { const a = ['safe']; const source: Record<number, unknown> = {}; if (flag) source[1] = error; Object.assign(a, source); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-source-populated-after-use-pin',
    source: `function frames(error: Error) { const a = ['safe']; const source: Record<number, unknown> = {}; Object.assign(a, source); source[1] = error; return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-source-populated-under-a-name-pin',
    source: `function frames(error: Error) { const a = ['safe']; const source: Record<string, unknown> = {}; source.label = error; Object.assign(a, source); return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-source-copied-into-member-pin',
    source: `function frames(error: Error) { const a = ['safe']; const source: Record<number, unknown> = {}; ({ ...source[1] } = error); Object.assign(a, source); return String(a); }`,
    converts: false,
  },
  {
    id: 'src-nested-field-of-spread-keeps-prototype',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const inner = { __proto__: { f: () => error } }; const source = { nested: inner }; ({ nested: { f: descriptor.get } } = { ...source }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-nested-field-of-spread-own-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const inner = { f: () => error }; const source = { nested: inner }; ({ nested: { f: descriptor.get } } = { ...source }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-spread-field-keeps-no-prototype-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const source = { __proto__: { nested: { f: () => error } } }; ({ nested: { f: descriptor.get } } = { ...source }); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'src-doubling-empty-lists-terminate',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const s0: unknown[] = []; const s1 = [...s0, ...s0]; const s2 = [...s1, ...s1]; const s3 = [...s2, ...s2]; const s4 = [...s3, ...s3]; const s5 = [...s4, ...s4]; const s6 = [...s5, ...s5]; const s7 = [...s6, ...s6]; const s8 = [...s7, ...s7]; const s9 = [...s8, ...s8]; const s10 = [...s9, ...s9]; const s11 = [...s10, ...s10]; const s12 = [...s11, ...s11]; const s13 = [...s12, ...s12]; const s14 = [...s13, ...s13]; const s15 = [...s14, ...s14]; const s16 = [...s15, ...s15]; const s17 = [...s16, ...s16]; const s18 = [...s17, ...s17]; const s19 = [...s18, ...s18]; const s20 = [...s19, ...s19]; const s21 = [...s20, ...s20]; const s22 = [...s21, ...s21]; const s23 = [...s22, ...s22]; const s24 = [...s23, ...s23]; const s25 = [...s24, ...s24]; [descriptor.get] = [...s25, () => error]; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-spread-list-popped',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const functions = [() => 'safe']; functions.pop(); [descriptor.get] = [...functions, () => error]; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-held-list-shifted',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const functions = [() => 'safe', () => error]; functions.shift(); [descriptor.get] = functions; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-held-list-spread-shifted',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const functions = [() => 'safe', () => error]; functions.shift(); [descriptor.get] = [...functions]; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-held-list-reversed',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const functions = [() => 'safe', () => error]; functions.reverse(); [descriptor.get] = functions; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-held-list-assigned-entry',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const functions = [() => 'safe']; functions[0] = () => error; [descriptor.get] = functions; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'src-held-list-read-only-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const functions = [() => 'safe', () => error]; const count = functions.length; [descriptor.get] = functions; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'src-held-list-aliased-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const functions = [() => 'safe', () => error]; const alias = functions; [descriptor.get] = alias; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-after-assign-call',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; Object.assign(descriptor, { get: undefined }); descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-after-define-call',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; Object.defineProperty(descriptor, 'get', { value: undefined }); descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-after-function-call',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; const clear = (value: PropertyDescriptor) => { value.get = undefined; }; clear(descriptor); descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-copied-to-assign-refused-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; const copy = Object.assign({}, descriptor); descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-rest-copy-of-selected-field-before-later-write',
    source: `function frames(error: Error) { const a = ['safe']; const maps: PropertyDescriptorMap = {}; const source: Record<string, PropertyDescriptor> = { a: {} }; ({ a: { ...maps[0] } } = source); source.a = { get: () => error }; Object.defineProperties(a, maps); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-rest-copy-of-selected-field-after-earlier-write-pin',
    source: `function frames(error: Error) { const a = ['safe']; const maps: PropertyDescriptorMap = {}; const source: Record<string, PropertyDescriptor> = { a: {} }; source.a = { get: () => error }; ({ a: { ...maps[0] } } = source); Object.defineProperties(a, maps); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-selected-field-captured-before-later-write',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const source = { f: () => 'safe' }; ({ f: descriptor.get } = source); source.f = () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-selected-field-captured-after-earlier-write-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const source: { f: () => unknown } = { f: () => 'safe' }; source.f = () => error; ({ f: descriptor.get } = source); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-selected-held-field-captured-before-later-write',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const holder: { nested: { f: () => unknown } } = { nested: { f: () => 'safe' } }; ({ nested: { f: descriptor.get } } = holder); holder.nested = { f: () => error }; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-write-back-into-own-source-terminates',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const source: any = { f: { f: () => 'safe' } }; ({ f: { f: source.f } } = source); ({ f: descriptor.get } = source); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-write-back-into-own-source-keeps-error',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const source: any = { f: { f: () => error } }; ({ f: { f: source.f } } = source); ({ f: descriptor.get } = source); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    // Refused since a literal that holds a followed object is followed no further: `two` holds `one`.
    id: 'define-mutual-write-back-terminates',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const one: any = { f: () => 'safe' }; const two: any = { f: one }; ({ f: one.f } = two); ({ f: two.f } = one); ({ f: descriptor.get } = one); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-rest-left-out-field-stays-out',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const holder: any = {}; let ignored: unknown; ({ f: ignored, ...holder.nested } = { f: () => error, g: 1 }); ({ nested: { f: descriptor.get } } = holder); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-rest-kept-field-comes-through-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const holder: any = {}; let ignored: unknown; ({ g: ignored, ...holder.nested } = { f: () => error }); ({ nested: { f: descriptor.get } } = holder); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-array-rest-entry-selected-later',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const holder: any = {}; let ignored: unknown; [ignored, ...holder.items] = [0, () => error]; ({ items: [descriptor.get] } = holder); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-array-rest-entry-offset-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const holder: any = {}; let ignored: unknown; [ignored, ...holder.items] = [() => error, () => 'safe']; ({ items: [descriptor.get] } = holder); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-spread-list-hidden-by-later-index',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { ...[error], 0: 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-spread-list-other-index-pin',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { ...[error], 1: 'safe' }); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-spread-list-before-index-pin',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { 0: 'safe', ...[error] }); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-spread-list-computed-index-hides',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { ...[error], ['0']: 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-spread-list-entry-hidden-only',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { ...['x', error], 1: 'y' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-spread-list-entry-kept',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { ...[error, 'x'], 1: 'y' }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-captured-reference-fields-written-later',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const inner: any = {}; const holder: any = {}; holder.nested = inner; inner.f = () => error; ({ nested: { f: descriptor.get } } = holder); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-copied-reference-fields-written-later-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const inner: any = {}; const holder: any = {}; ({ ...holder.nested } = inner); inner.f = () => error; ({ nested: { f: descriptor.get } } = holder); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-captured-reference-fields-written-earlier',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const inner: any = {}; const holder: any = {}; inner.f = () => error; holder.nested = inner; ({ nested: { f: descriptor.get } } = holder); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-captured-reference-read-before-write-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const inner: any = {}; const holder: any = {}; holder.nested = inner; ({ nested: { f: descriptor.get } } = holder); inner.f = () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-array-rest-member-is-no-descriptor',
    source: `function frames(error: Error) { const a = ['safe']; const maps: PropertyDescriptorMap = {}; const holder: any = {}; [...holder.items] = [{ get: () => error }]; ({ items: maps[0] } = holder); Object.defineProperties(a, maps); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-array-rest-member-whole-is-an-array-value',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const holder: any = {}; [...holder.items] = [error]; ({ items: descriptor.value } = holder); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-array-rest-member-named-property-is-no-entry',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const holder: any = {}; [...holder.items] = [error]; ({ items: { length: descriptor.value } } = holder); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-array-rest-member-second-rest-offset',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const holder: any = {}; let ignored: unknown; let again: unknown; [ignored, ...holder.items] = [0, error, 'safe']; ({ items: [again, ...descriptor.value] } = holder); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-array-rest-member-second-rest-keeps-error-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const holder: any = {}; let ignored: unknown; let again: unknown; [ignored, ...holder.items] = [0, 'x', error]; ({ items: [again, ...descriptor.value] } = holder); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-array-rest-member-index-entry',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const holder: any = {}; let ignored: unknown; [ignored, ...holder.items] = [0, error]; ({ items: [descriptor.value] } = holder); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'descriptor-declared-without-a-value-and-assigned-is-refused',
    source: `function frames(error: Error, flag: boolean, original: any) { const a: any[] = ['safe']; let d: any; d = { get: () => error }; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'descriptor-declared-with-var-and-assigned-is-refused',
    source: `function frames(error: Error, flag: boolean, original: any) { const a: any[] = ['safe']; var d: any; d = { get: () => error }; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'map-declared-without-a-value-and-assigned-is-refused',
    source: `function frames(error: Error, flag: boolean, original: any) { const a: any[] = ['safe']; let m: any; m = { 0: { get: () => error } }; Object.defineProperties(a, m); return String(a); }`,
    converts: true,
  },
  {
    id: 'source-declared-without-a-value-and-assigned-is-refused',
    source: `function frames(error: Error, flag: boolean, original: any) { const a: any[] = ['safe']; let s: any; s = { 0: error }; Object.assign(a, s); return String(a); }`,
    converts: true,
  },
  {
    id: 'descriptor-of-a-for-of-head-is-refused',
    source: `function frames(error: Error, flag: boolean, original: any) { const a: any[] = ['safe']; for (const d of [{ get: () => error }]) { Object.defineProperty(a, 0, d); } return String(a); }`,
    converts: true,
  },
  {
    id: 'descriptor-of-a-for-of-head-with-let-is-refused',
    source: `function frames(error: Error, flag: boolean, original: any) { const a: any[] = ['safe']; for (let d of [{ get: () => error }]) { Object.defineProperty(a, 0, d); } return String(a); }`,
    converts: true,
  },
  {
    id: 'name-of-a-for-in-head-stays-refused',
    source: `function frames(error: Error, flag: boolean, original: any) { const a: any[] = ['safe']; for (const d in { x: 1 }) { Object.defineProperty(a, 0, d as any); } return String(a); }`,
    converts: true,
  },
  {
    id: 'descriptor-assigned-by-a-pattern-is-refused',
    source: `function frames(error: Error, flag: boolean, original: any) { const a: any[] = ['safe']; let d: any; ({ d } = { d: { get: () => error } }); Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'descriptor-assigned-in-a-branch-is-refused',
    source: `function frames(error: Error, flag: boolean, original: any) { const a: any[] = ['safe']; let d: any; if (flag) { d = { get: () => error }; } Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'descriptor-assigned-by-a-logical-assignment-is-refused',
    source: `function frames(error: Error, flag: boolean, original: any) { const a: any[] = ['safe']; let d: any; d ??= { get: () => error }; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'descriptor-assigned-in-a-closure-is-refused',
    source: `function frames(error: Error, flag: boolean, original: any) { const a: any[] = ['safe']; let d: any; const set = () => { d = { get: () => error }; }; set(); Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'descriptor-declared-without-a-value-and-never-assigned-pin',
    source: `function frames(error: Error, flag: boolean, original: any) { const a: any[] = ['safe']; let d: any; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: false,
  },
  {
    id: 'descriptor-parameter-pin',
    source: `function frames(error: Error, flag: boolean, original: any) { const a: any[] = ['safe']; Object.defineProperty(a, 0, original); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-array-rest-member-index-offset-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const holder: any = {}; let ignored: unknown; [ignored, ...holder.items] = [error, 'safe']; ({ items: [descriptor.value] } = holder); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-spread-list-empty-spread-then-entry-hidden-at-runtime-index',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { ...[...[], error], 1: 'safe' }); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-spread-list-entry-survives-inner-spread-start-hidden',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { ...[...['x', error]], 0: 'safe' }); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-spread-list-inner-spread-entry-hidden',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { ...[...[error, 'x']], 0: 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-spread-list-held-spread-entry-hidden',
    source: `function frames(error: Error) { const a = ['safe']; const pair = [error, 'x']; Object.assign(a, { ...[...pair], 0: 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-spread-list-held-spread-later-entry-kept',
    source: `function frames(error: Error) { const a = ['safe']; const pair = [error]; Object.assign(a, { ...[...pair, 'x'], 1: 'safe' }); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-spread-list-held-spread-first-entry-hidden',
    source: `function frames(error: Error) { const a = ['safe']; const pair = [error]; Object.assign(a, { ...[...pair, 'x'], 0: 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-spread-list-unknown-spread-keeps-entries',
    source: `function frames(error: Error, list: unknown[]) { const a = ['safe']; Object.assign(a, { ...[...list, error], 0: 'safe' }); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-spread-list-hole-takes-a-position',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { ...[, error], 0: 'safe' }); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-spread-list-doubling-lists-terminate',
    source: `function frames(error: Error) { const a = ['safe']; const s0: unknown[] = []; const s1 = [...s0, ...s0]; const s2 = [...s1, ...s1]; const s3 = [...s2, ...s2]; const s4 = [...s3, ...s3]; const s5 = [...s4, ...s4]; const s6 = [...s5, ...s5]; const s7 = [...s6, ...s6]; const s8 = [...s7, ...s7]; const s9 = [...s8, ...s8]; const s10 = [...s9, ...s9]; const s11 = [...s10, ...s10]; const s12 = [...s11, ...s11]; const s13 = [...s12, ...s12]; const s14 = [...s13, ...s13]; const s15 = [...s14, ...s14]; const s16 = [...s15, ...s15]; const s17 = [...s16, ...s16]; const s18 = [...s17, ...s17]; const s19 = [...s18, ...s18]; const s20 = [...s19, ...s19]; const s21 = [...s20, ...s20]; const s22 = [...s21, ...s21]; const s23 = [...s22, ...s22]; const s24 = [...s23, ...s23]; const s25 = [...s24, ...s24]; Object.assign(a, { ...[...s25, error], 0: 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-spread-list-far-hidden-key-excludes-hidden-entry',
    source: `function frames(error: Error) { const a = ['safe']; const s0 = ['safe']; const s1 = [...s0, ...s0]; const s2 = [...s1, ...s1]; const s3 = [...s2, ...s2]; const s4 = [...s3, ...s3]; const s5 = [...s4, ...s4]; const s6 = [...s5, ...s5]; const s7 = [...s6, ...s6]; const s8 = [...s7, ...s7]; const s9 = [...s8, ...s8]; const s10 = [...s9, ...s9]; const s11 = [...s10, ...s10]; const s12 = [...s11, ...s11]; const s13 = [...s12, ...s12]; const s14 = [...s13, ...s13]; Object.assign(a, { ...[error, ...s14], 0: 'safe', 1000000: 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-spread-list-far-hidden-key-keeps-later-entry',
    source: `function frames(error: Error) { const a = ['safe']; const s0 = ['safe']; const s1 = [...s0, ...s0]; const s2 = [...s1, ...s1]; const s3 = [...s2, ...s2]; const s4 = [...s3, ...s3]; const s5 = [...s4, ...s4]; const s6 = [...s5, ...s5]; const s7 = [...s6, ...s6]; const s8 = [...s7, ...s7]; const s9 = [...s8, ...s8]; const s10 = [...s9, ...s9]; const s11 = [...s10, ...s10]; const s12 = [...s11, ...s11]; const s13 = [...s12, ...s12]; const s14 = [...s13, ...s13]; Object.assign(a, { ...['safe', error, ...s14], 0: 'safe', 1000000: 'safe' }); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-spread-list-far-hidden-key-hides-entry-after-shared-lists',
    source: `function frames(error: Error) { const a = ['safe']; const s0 = ['safe']; const s1 = [...s0, ...s0]; const s2 = [...s1, ...s1]; const s3 = [...s2, ...s2]; const s4 = [...s3, ...s3]; const s5 = [...s4, ...s4]; const s6 = [...s5, ...s5]; const s7 = [...s6, ...s6]; const s8 = [...s7, ...s7]; const s9 = [...s8, ...s8]; const s10 = [...s9, ...s9]; const s11 = [...s10, ...s10]; const s12 = [...s11, ...s11]; const s13 = [...s12, ...s12]; const s14 = [...s13, ...s13]; Object.assign(a, { ...[...s14, error], 16384: 'safe', 1000000: 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-spread-list-far-hidden-key-keeps-entry-before-hidden-pin',
    source: `function frames(error: Error) { const a = ['safe']; const s0 = ['safe']; const s1 = [...s0, ...s0]; const s2 = [...s1, ...s1]; const s3 = [...s2, ...s2]; const s4 = [...s3, ...s3]; const s5 = [...s4, ...s4]; const s6 = [...s5, ...s5]; const s7 = [...s6, ...s6]; const s8 = [...s7, ...s7]; const s9 = [...s8, ...s8]; const s10 = [...s9, ...s9]; const s11 = [...s10, ...s10]; const s12 = [...s11, ...s11]; const s13 = [...s12, ...s12]; const s14 = [...s13, ...s13]; Object.assign(a, { ...[...s14, error], 16383: 'safe', 1000000: 'safe' }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-prototype-field-shadowed-by-constant-spread-pin',
    source: `function frames(error: Error) { const a = ['safe']; const own = { get: () => 'safe' }; Object.defineProperty(a, 0, { __proto__: { get: () => error }, ...own }); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-spread-list-shared-doubling-lists-safe-terminate',
    source: `function frames(error: Error) { const a = ['safe']; const s0 = ['safe']; const s1 = [...s0, ...s0]; const s2 = [...s1, ...s1]; const s3 = [...s2, ...s2]; const s4 = [...s3, ...s3]; const s5 = [...s4, ...s4]; const s6 = [...s5, ...s5]; const s7 = [...s6, ...s6]; const s8 = [...s7, ...s7]; const s9 = [...s8, ...s8]; const s10 = [...s9, ...s9]; const s11 = [...s10, ...s10]; const s12 = [...s11, ...s11]; const s13 = [...s12, ...s12]; const s14 = [...s13, ...s13]; const s15 = [...s14, ...s14]; const s16 = [...s15, ...s15]; const s17 = [...s16, ...s16]; const s18 = [...s17, ...s17]; const s19 = [...s18, ...s18]; const s20 = [...s19, ...s19]; const s21 = [...s20, ...s20]; const s22 = [...s21, ...s21]; const s23 = [...s22, ...s22]; const s24 = [...s23, ...s23]; const s25 = [...s24, ...s24]; Object.assign(a, { ...[...s25], 0: 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-spread-list-shared-doubling-lists-error-after-hidden',
    source: `function frames(error: Error) { const a = ['safe']; const s0 = [error]; const s1 = [...s0, ...s0]; const s2 = [...s1, ...s1]; const s3 = [...s2, ...s2]; const s4 = [...s3, ...s3]; const s5 = [...s4, ...s4]; const s6 = [...s5, ...s5]; const s7 = [...s6, ...s6]; const s8 = [...s7, ...s7]; const s9 = [...s8, ...s8]; const s10 = [...s9, ...s9]; const s11 = [...s10, ...s10]; const s12 = [...s11, ...s11]; const s13 = [...s12, ...s12]; const s14 = [...s13, ...s13]; const s15 = [...s14, ...s14]; const s16 = [...s15, ...s15]; const s17 = [...s16, ...s16]; const s18 = [...s17, ...s17]; const s19 = [...s18, ...s18]; const s20 = [...s19, ...s19]; const s21 = [...s20, ...s20]; const s22 = [...s21, ...s21]; const s23 = [...s22, ...s22]; const s24 = [...s23, ...s23]; const s25 = [...s24, ...s24]; Object.assign(a, { ...[...s25], 0: 'safe' }); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-spread-list-shared-doubling-lists-far-hidden-key',
    source: `function frames(error: Error) { const a = ['safe']; const s0 = [error]; const s1 = [...s0, ...s0]; const s2 = [...s1, ...s1]; const s3 = [...s2, ...s2]; const s4 = [...s3, ...s3]; const s5 = [...s4, ...s4]; const s6 = [...s5, ...s5]; const s7 = [...s6, ...s6]; const s8 = [...s7, ...s7]; const s9 = [...s8, ...s8]; const s10 = [...s9, ...s9]; const s11 = [...s10, ...s10]; const s12 = [...s11, ...s11]; const s13 = [...s12, ...s12]; const s14 = [...s13, ...s13]; const s15 = [...s14, ...s14]; const s16 = [...s15, ...s15]; const s17 = [...s16, ...s16]; const s18 = [...s17, ...s17]; const s19 = [...s18, ...s18]; const s20 = [...s19, ...s19]; const s21 = [...s20, ...s20]; const s22 = [...s21, ...s21]; const s23 = [...s22, ...s22]; const s24 = [...s23, ...s23]; const s25 = [...s24, ...s24]; Object.assign(a, { ...[...s25], 1000000: 'safe' }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-array-rest-member-whole-skips-consumed-entries',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const holder: any = {}; let ignored: unknown; [ignored, ...holder.items] = [error, 'safe']; ({ items: descriptor.value } = holder); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-array-rest-member-whole-keeps-later-entries',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = {}; const holder: any = {}; let ignored: unknown; [ignored, ...holder.items] = ['safe', error]; ({ items: descriptor.value } = holder); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-rest-excludes-constant-computed-key',
    source: `function frames(error: Error, flag: boolean) { const a = ['safe']; const maps: PropertyDescriptorMap = {}; let ignored: unknown; const key = 'get'; ({ [key]: ignored, ...maps[0] } = { get: () => error, value: 'safe' }); Object.defineProperties(a, maps); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-rest-excludes-literal-computed-key',
    source: `function frames(error: Error, flag: boolean) { const a = ['safe']; const maps: PropertyDescriptorMap = {}; let ignored: unknown;  ({ ['get']: ignored, ...maps[0] } = { get: () => error, value: 'safe' }); Object.defineProperties(a, maps); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-rest-excludes-aliased-constant-computed-key',
    source: `function frames(error: Error, flag: boolean) { const a = ['safe']; const maps: PropertyDescriptorMap = {}; let ignored: unknown; const first = 'get'; const key = first; ({ [key]: ignored, ...maps[0] } = { get: () => error, value: 'safe' }); Object.defineProperties(a, maps); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-rest-keeps-conditional-computed-key',
    source: `function frames(error: Error, flag: boolean) { const a = ['safe']; const maps: PropertyDescriptorMap = {}; let ignored: unknown; const key = flag ? 'get' : 'value'; ({ [key]: ignored, ...maps[0] } = { get: () => error, value: 'safe' }); Object.defineProperties(a, maps); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-rest-keeps-unrelated-constant-computed-key',
    source: `function frames(error: Error, flag: boolean) { const a = ['safe']; const maps: PropertyDescriptorMap = {}; let ignored: unknown; const key = 'value'; ({ [key]: ignored, ...maps[0] } = { get: () => error, value: 'safe' }); Object.defineProperties(a, maps); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-getter-from-destructured-constant',
    source: `function frames(error: Error) { const a = ['safe']; const { get } = { get: () => error }; Object.defineProperty(a, 0, { get }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-getter-from-renamed-destructured-constant',
    source: `function frames(error: Error) { const a = ['safe']; const { get: reader } = { get: () => error }; Object.defineProperty(a, 0, { get: reader }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-getter-from-nested-destructured-constant',
    source: `function frames(error: Error) { const a = ['safe']; const { outer: { get } } = { outer: { get: () => error } }; Object.defineProperty(a, 0, { get }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-getter-from-array-destructured-constant',
    source: `function frames(error: Error) { const a = ['safe']; const [get] = [() => error]; Object.defineProperty(a, 0, { get }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-getter-from-destructured-held-object',
    source: `function frames(error: Error) { const a = ['safe']; const source = { get: () => error }; const { get } = source; Object.defineProperty(a, 0, { get }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-getter-from-destructured-held-object-written-after-capture',
    source: `function frames(error: Error) { const a = ['safe']; const source: any = { get: () => 'safe' }; const { get } = source; source.get = () => error; Object.defineProperty(a, 0, { get }); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-getter-from-destructured-held-object-written-before-capture',
    source: `function frames(error: Error) { const a = ['safe']; const source: any = { get: () => 'safe' }; source.get = () => error; const { get } = source; Object.defineProperty(a, 0, { get }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-safe-getter-from-destructured-constant-pin',
    source: `function frames(error: Error) { const a = ['safe']; const { get } = { get: () => 'safe' }; Object.defineProperty(a, 0, { get }); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-getter-from-destructured-other-field-pin',
    source: `function frames(error: Error) { const a = ['safe']; const { other } = { get: () => error, other: () => 'safe' }; Object.defineProperty(a, 0, { get: other }); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-array-rest-member-captured-twice-is-no-descriptor',
    source: `function frames(error: Error) { const a = ['safe']; const holder: any = {}; const other: any = {}; const maps: any = {}; [...holder.items] = [{ get: () => error }]; ({ items: other.nested } = holder); ({ nested: maps[0] } = other); Object.defineProperties(a, maps); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-array-rest-member-captured-refused-pin',
    source: `function frames(error: Error) { const a = ['safe']; const holder: any = {}; const other: any = {}; const maps: any = {}; [...holder.items] = [{ get: () => error }]; ({ items: other.nested } = holder); Object.defineProperties(a, { 0: other.nested }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-array-rest-member-captured-copy-refused-pin',
    source: `function frames(error: Error) { const a = ['safe']; const holder: any = {}; const other: any = {}; const maps: any = {}; [...holder.items] = [{ get: () => error }]; other.nested = holder.items; Object.defineProperties(a, { 0: other.nested }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-after-apply-list-call',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; Reflect.apply(Object.assign, null, [descriptor, { get: undefined }]); descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-after-apply-method-list-call',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; Object.assign.apply(null, [descriptor, { get: undefined }]); descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-after-list-argument',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; const clear = (list: PropertyDescriptor[]) => { list[0]!.get = undefined; }; clear([descriptor]); descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-after-shorthand-literal-argument',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; const clear = (box: { descriptor: PropertyDescriptor }) => { box.descriptor.get = undefined; }; clear({ descriptor }); descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-after-field-literal-argument',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; const clear = (box: { inner: PropertyDescriptor }) => { box.inner.get = undefined; }; clear({ inner: descriptor }); descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-after-held-in-list',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; const list = [descriptor]; list[0]!.get = undefined; descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-after-held-in-object',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; const holder = { descriptor }; holder.descriptor.get = undefined; descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-after-for-each',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; [descriptor].forEach((each) => { each.get = undefined; }); descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-after-returned',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; const read = () => descriptor; read().get = undefined; descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-after-self-reference',
    source: `function frames(error: Error) { const a = ['safe']; const cyclic: any = { get: () => 'safe', self: undefined }; cyclic.self = cyclic; cyclic.self.get = undefined; cyclic.get ??= () => error; Object.defineProperty(a, 0, cyclic); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-after-conditional-alias',
    source: `function frames(error: Error, flag: boolean) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; const alias = flag ? descriptor : descriptor; alias.get = undefined; descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-after-tagged-template',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; const clear = (_strings: TemplateStringsArray, value: PropertyDescriptor) => { value.get = undefined; }; clear\`\${descriptor}\`; descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-after-method-call-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: any = { get: () => 'safe', reset() { this.get = undefined; } }; descriptor.reset(); descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-after-member-read-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; const own = descriptor.get; descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-logical-after-destructuring-read-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; const { get } = descriptor; descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-logical-after-spread-copy-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; const copy = { ...descriptor }; descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-logical-in-apply-list-source-refused-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; Reflect.apply(Object.assign, null, [{}, descriptor]); descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-in-descriptor-map-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; descriptor.get ??= () => error; Object.defineProperties(a, { 0: descriptor }); return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-array-source-written-after-copy-pin',
    source: `function frames(error: Error) { const a = ['safe']; const source: unknown[] = ['safe']; Object.assign(a, source); source[0] = error; return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-over-target-setter-pin',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperty(a, 0, { set(_value: unknown) {} }); Object.assign(a, { 0: error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'form-read-as-a-descriptor-and-as-a-map-is-refused',
    source: `function frames(error: Error, flag: boolean, original: any) { const mk = (): any => ({ get: () => error }); const shared: any = { 0: mk() }; const a: any[] = ['safe']; Object.defineProperties(a, { ...shared, 1: shared }); return String(a); }`,
    converts: true,
  },
  {
    id: 'form-read-as-a-map-and-as-a-descriptor-is-refused',
    source: `function frames(error: Error, flag: boolean, original: any) { const mk = (): any => ({ get: () => error }); const shared: any = { 0: mk() }; const a: any[] = ['safe']; Object.defineProperties(a, { 1: shared, ...shared }); return String(a); }`,
    converts: true,
  },
  {
    id: 'list-read-as-a-spread-and-as-an-entry-is-refused',
    source: `function frames(error: Error, flag: boolean, original: any) { const mk = (): any => ({ get: () => error }); const shared: any = [mk()]; const a: any[] = ['safe']; Object.defineProperties(a, [...shared, shared] as any); return String(a); }`,
    converts: true,
  },
  {
    id: 'nested-form-read-as-a-descriptor-and-as-a-map-is-refused',
    source: `function frames(error: Error, flag: boolean, original: any) { const mk = (): any => ({ get: () => error }); const inner: any = { 0: mk() }; const outer: any = { ...inner, 1: inner }; const a: any[] = ['safe']; Object.defineProperties(a, outer); return String(a); }`,
    converts: true,
  },
  {
    id: 'nested-form-read-as-a-map-and-as-a-descriptor-is-refused',
    source: `function frames(error: Error, flag: boolean, original: any) { const mk = (): any => ({ get: () => error }); const inner: any = { 0: mk() }; const outer: any = { 1: inner, ...inner }; const a: any[] = ['safe']; Object.defineProperties(a, outer); return String(a); }`,
    converts: true,
  },
  {
    id: 'form-read-in-two-roles-with-known-values-pin',
    source: `function frames(error: Error, flag: boolean, original: any) { const mk = (): any => ({ get: () => error }); const shared: any = { 0: 'safe' }; const a: any[] = ['safe']; Object.defineProperties(a, { ...shared, 1: shared }); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-logical-after-condition-test-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; if (descriptor) {} descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-logical-after-ternary-test-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; const picked = descriptor ? 1 : 2; descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-logical-after-negation-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; const missing = !descriptor; descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-logical-after-type-test-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; const kind = typeof descriptor; descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-logical-after-identity-test-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; const same = descriptor === descriptor; descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-logical-after-in-test-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; const has = 'get' in descriptor; descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-logical-after-loop-test-pin',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; while (descriptor) { break; } descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-logical-after-logical-alias',
    source: `function frames(error: Error, flag: boolean) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; const alias = flag && descriptor; if (alias) alias.get = undefined; descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-after-equality-coercion',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; const same = descriptor == 1; descriptor.get ??= () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-rest-list-member-installs-array-pin',
    source: `function frames(error: Error) { const a = ['safe']; const src: any = {}; [...src[0]] = [error]; Object.assign(a, src); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-rest-list-member-other-slot-pin',
    source: `function frames(error: Error) { const a = ['safe']; const src: any = {}; [...src[1]] = [error]; Object.assign(a, src); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-and-on-inherited-member-runs',
    source: `function frames(error: Error) { const a = ['safe']; const holder: any = {}; const descriptor: PropertyDescriptor = {}; holder.constructor &&= () => error; ({ constructor: descriptor.get } = holder); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-and-on-inherited-to-string-runs',
    source: `function frames(error: Error) { const a = ['safe']; const holder: any = {}; const descriptor: PropertyDescriptor = {}; holder.toString &&= () => error; ({ toString: descriptor.get } = holder); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-or-on-inherited-member-stays-possible-pin',
    source: `function frames(error: Error) { const a = ['safe']; const holder: any = {}; const descriptor: PropertyDescriptor = {}; holder.constructor ||= () => error; ({ constructor: descriptor.get } = holder); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-logical-and-on-missing-member-skips-pin',
    source: `function frames(error: Error) { const a = ['safe']; const holder: any = {}; const descriptor: PropertyDescriptor = {}; holder.reader &&= () => error; ({ reader: descriptor.get } = holder); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-logical-nullish-on-missing-member-runs-pin',
    source: `function frames(error: Error) { const a = ['safe']; const holder: any = {}; const descriptor: PropertyDescriptor = {}; holder.reader ??= () => error; ({ reader: descriptor.get } = holder); Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'callee-reflect-define-property',
    source: `function frames(error: Error) { const a = ['safe']; Reflect.defineProperty(a, 0, { get: () => error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'callee-comma-define-property',
    source: `function frames(error: Error) { const a = ['safe']; (0, Object.defineProperty)(a, 0, { get: () => error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'callee-comma-assign',
    source: `function frames(error: Error) { const a = ['safe']; (0, Object.assign)(a, { 0: error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'callee-constant-alias-define-property',
    source: `function frames(error: Error) { const a = ['safe']; const define = Object.defineProperty; define(a, 0, { get: () => error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'callee-constant-alias-of-reflect-define-property',
    source: `function frames(error: Error) { const a = ['safe']; const define = Reflect.defineProperty; define(a, 0, { get: () => error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'callee-constant-alias-of-alias',
    source: `function frames(error: Error) { const a = ['safe']; const first = Object.defineProperty; const define = first; define(a, 0, { get: () => error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'callee-constant-alias-call',
    source: `function frames(error: Error) { const a = ['safe']; const define = Object.defineProperty; define.call(Object, a, 0, { get: () => error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'callee-constant-alias-apply',
    source: `function frames(error: Error) { const a = ['safe']; const define = Object.defineProperty; define.apply(Object, [a, 0, { get: () => error }]); return String(a); }`,
    converts: true,
  },
  {
    id: 'callee-reflect-define-property-call',
    source: `function frames(error: Error) { const a = ['safe']; Reflect.defineProperty.call(Reflect, a, 0, { get: () => error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'callee-reflect-apply-of-alias',
    source: `function frames(error: Error) { const a = ['safe']; const define = Object.defineProperty; Reflect.apply(define, Object, [a, 0, { get: () => error }]); return String(a); }`,
    converts: true,
  },
  {
    id: 'callee-call-form-pin',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperty.call(Object, a, 0, { get: () => error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'callee-apply-form-pin',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperty.apply(Object, [a, 0, { get: () => error }]); return String(a); }`,
    converts: true,
  },
  {
    id: 'callee-reflect-apply-pin',
    source: `function frames(error: Error) { const a = ['safe']; Reflect.apply(Object.defineProperty, Object, [a, 0, { get: () => error }]); return String(a); }`,
    converts: true,
  },
  {
    id: 'callee-comma-of-a-reader-adds-nothing-pin',
    source: `function frames(error: Error) { const a = ['safe']; (0, Object.keys)(a); return String(a); }`,
    converts: false,
  },
  {
    id: 'callee-alias-of-a-reader-adds-nothing-pin',
    source: `function frames(error: Error) { const a = ['safe']; const keys = Object.keys; keys(a); return String(a); }`,
    converts: false,
  },
  {
    id: 'callee-safe-descriptor-through-reflect-pin',
    source: `function frames(error: Error) { const a = ['safe']; Reflect.defineProperty(a, 0, { get: () => 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'reassigned-let-array-holds-the-error-written-later',
    source: `function frames(error: Error) { let values: unknown[] = []; values = [error]; return String(values); }`,
    converts: true,
  },
  {
    id: 'reassigned-let-array-holds-the-error-written-in-a-branch',
    source: `function frames(error: Error) { let values: unknown[] = []; if (error.message) values = [error]; return String(values); }`,
    converts: true,
  },
  {
    id: 'let-array-never-reassigned-pin',
    source: `function frames(error: Error) { let values: unknown[] = ['safe']; return String(values); }`,
    converts: false,
  },
  {
    id: 'let-array-pushed-never-reassigned-pin',
    source: `function frames(error: Error) { let values: unknown[] = ['safe']; values.push('also safe'); return String(values); }`,
    converts: false,
  },
  {
    id: 'reassigned-let-array-of-safe-values-stays-possible-pin',
    source: `function frames(error: Error) { let values: unknown[] = ['safe']; values = ['also safe']; return String(values); }`,
    converts: true,
  },
  {
    id: 'constant-array-pin',
    source: `function frames(error: Error) { const values: unknown[] = ['safe']; return String(values); }`,
    converts: false,
  },
  {
    id: 'reassigned-alias-of-an-empty-array-converts',
    source: `function frames(error: Error) { const original: any[] = []; let values = original; values = [error]; return String(values); }`,
    converts: true,
  },
  {
    id: 'reassigned-alias-of-a-reassigned-name-converts',
    source: `function frames(error: Error) { let one: any[] = []; let two = one; two = [error]; return String(two); }`,
    converts: true,
  },
  {
    id: 'alias-never-reassigned-pin',
    source: `function frames(error: Error) { const original: any[] = ['safe']; let values = original; return String(values); }`,
    converts: false,
  },
  {
    id: 'reassigned-scalar-alias-pin',
    source: `function frames(error: Error) { const initial = 'safe'; let text: string = initial; text = 'still safe'; return String([text]); }`,
    converts: false,
  },
  {
    id: 'param-chain-reassigned-converts',
    source: `function frames(error: Error, original: unknown[]) { let values = original; values = [error]; return String(values); }`,
    converts: true,
  },
  {
    id: 'scalar-alias-reassigned-pin',
    source: `function frames(error: Error, original: unknown[]) { const initial = 'safe'; let text: string = initial; text = 'still safe'; return String([text]); }`,
    converts: false,
  },
  {
    id: 'destructured-scalar-alias-reassigned-pin',
    source: `function frames(error: Error, original: unknown[]) { const [initial] = ['safe']; let text: string = initial; text = 'still safe'; return String([text]); }`,
    converts: false,
  },
  {
    id: 'destructured-array-alias-reassigned-converts',
    source: `function frames(error: Error, original: unknown[]) { const [inner] = [[] as any[]]; let values = inner; values = [error]; return String(values); }`,
    converts: true,
  },
  {
    id: 'object-field-array-alias-reassigned-converts',
    source: `function frames(error: Error, original: unknown[]) { const { inner } = { inner: [] as any[] }; let values = inner; values = [error]; return String(values); }`,
    converts: true,
  },
  {
    id: 'negative-number-reassigned-pin',
    source: `function frames(error: Error, original: unknown[], flag: boolean) { let count = -1; count = 2; return String([count]); }`,
    converts: false,
  },
  {
    id: 'typed-negative-number-reassigned-pin',
    source: `function frames(error: Error, original: unknown[], flag: boolean) { let count: number = -1; count = 0; return String([count]); }`,
    converts: false,
  },
  {
    id: 'bigint-reassigned-pin',
    source: `function frames(error: Error, original: unknown[], flag: boolean) { let count = 1n; count = 2n; return String([count]); }`,
    converts: false,
  },
  {
    id: 'arithmetic-reassigned-pin',
    source: `function frames(error: Error, original: unknown[], flag: boolean) { let count = 1 + 2 * 3; count = 0; return String([count]); }`,
    converts: false,
  },
  {
    id: 'typeof-reassigned-pin',
    source: `function frames(error: Error, original: unknown[], flag: boolean) { let kind = typeof original; kind = 'other'; return String([kind]); }`,
    converts: false,
  },
  {
    id: 'comparison-reassigned-pin',
    source: `function frames(error: Error, original: unknown[], flag: boolean) { let same = original === original; same = false; return String([same]); }`,
    converts: false,
  },
  {
    id: 'conditional-of-scalars-reassigned-pin',
    source: `function frames(error: Error, original: unknown[], flag: boolean) { let count = flag ? 1 : -1; count = 2; return String([count]); }`,
    converts: false,
  },
  {
    id: 'choice-of-scalars-reassigned-pin',
    source: `function frames(error: Error, original: unknown[], flag: boolean) { let text = 'safe' || 'other'; text = 'still safe'; return String([text]); }`,
    converts: false,
  },
  {
    id: 'sequence-ending-at-a-scalar-reassigned-pin',
    source: `function frames(error: Error, original: unknown[], flag: boolean) { let count = (original.length, 0); count = 1; return String([count]); }`,
    converts: false,
  },
  {
    id: 'conditional-with-an-unknown-branch-reassigned-converts',
    source: `function frames(error: Error, original: unknown[], flag: boolean) { let values = flag ? 'safe' : original; values = 'other'; return String([values]); }`,
    converts: true,
  },
  {
    id: 'choice-with-an-unknown-operand-reassigned-converts',
    source: `function frames(error: Error, original: unknown[], flag: boolean) { let values = 'safe' && original; values = 'other'; return String([values]); }`,
    converts: true,
  },
  {
    id: 'sequence-ending-at-an-unknown-reassigned-converts',
    source: `function frames(error: Error, original: unknown[], flag: boolean) { let values = (0, original); values = 'other'; return String([values]); }`,
    converts: true,
  },
  {
    id: 'member-read-reassigned-stays-refused',
    source: `function frames(error: Error, original: unknown[], flag: boolean) { let size = original.length; size = 0; return String([size]); }`,
    converts: true,
  },
  {
    id: 'define-descriptor-getter-before-value-writes-value',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperty(a, 0, { get enumerable() { this.value = error; return true; }, value: 'safe' }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-descriptor-getter-before-value-writes-get',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperty(a, 0, { get configurable() { delete this.value; this.get = () => error; return true; }, value: 'safe' }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-descriptor-spread-getter-writes-value',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperty(a, 0, { ...{ get enumerable() { this.value = error; return true; }, value: 'safe' }, enumerable: true }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-descriptor-spread-getter-write-overwritten-adds-nothing',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperty(a, 0, { ...{ get enumerable() { this.value = error; return true; }, value: 'old' }, value: 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-descriptor-getter-never-read-adds-nothing-pin',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperty(a, 0, { get probe() { this.value = error; return true; }, value: 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-descriptor-getter-writes-another-field-adds-nothing-pin',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperty(a, 0, { get enumerable() { this.label = error; return true; }, value: 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'inherited-getter-rewrites-own-value',
    source: `function frames(error: Error) { const a: any[] = ['safe']; Object.defineProperty(a, 0, { __proto__: { get enumerable() { this.value = error; return true; } }, value: 'safe' }); return String(a); }`,
    converts: true,
  },
  {
    id: 'own-attribute-hides-inherited-getter-pin',
    source: `function frames(error: Error) { const a: any[] = ['safe']; Object.defineProperty(a, 0, { __proto__: { get enumerable() { this.value = error; return true; } }, enumerable: false, value: 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'spread-copies-value-before-getter-pin',
    source: `function frames(error: Error) { const a: any[] = ['safe']; Object.defineProperty(a, 0, { ...{ value: 'safe', get enumerable() { this.value = error; return true; } } }); return String(a); }`,
    converts: false,
  },
  {
    id: 'spread-runs-getter-before-value',
    source: `function frames(error: Error) { const a: any[] = ['safe']; Object.defineProperty(a, 0, { ...{ get enumerable() { this.value = error; return true; }, value: 'safe' } }); return String(a); }`,
    converts: true,
  },
  {
    id: 'spread-getter-writes-a-field-the-source-lacks-pin',
    source: `function frames(error: Error) { const a: any[] = ['safe']; Object.defineProperty(a, 0, { ...{ get enumerable() { this.value = error; return true; } } }); return String(a); }`,
    converts: false,
  },
  {
    id: 'own-attribute-after-inherited-getter-writes-value-pin',
    source: `function frames(error: Error) { const a: any[] = ['safe']; Object.defineProperty(a, 0, { __proto__: { get enumerable() { this.value = error; return true; } }, value: 'safe', enumerable: true }); return String(a); }`,
    converts: false,
  },
  {
    id: 'descriptor-writable-getter-writes-the-value-after-it-was-read-pin',
    source: `function frames(error: Error) { const a: any[] = ['safe']; Object.defineProperty(a, 0, { value: 'safe', get writable() { this.value = error; return true; } }); return String(a); }`,
    converts: false,
  },
  {
    id: 'descriptor-enumerable-getter-writes-the-value',
    source: `function frames(error: Error) { const a: any[] = ['safe']; Object.defineProperty(a, 0, { get enumerable() { this.value = error; return true; }, value: 'safe' }); return String(a); }`,
    converts: true,
  },
  {
    id: 'descriptor-later-spread-replaces-the-getter-pin',
    source: `function frames(error: Error) { const a: any[] = ['safe']; Object.defineProperty(a, 0, { get enumerable() { this.value = error; return true; }, value: 'safe', ...{ enumerable: true } }); return String(a); }`,
    converts: false,
  },
  {
    id: 'descriptor-later-spread-with-a-getter-may-keep-the-getter',
    source: `function frames(error: Error) { const a: any[] = ['safe']; Object.defineProperty(a, 0, { get enumerable() { this.value = error; return true; }, value: 'safe', ...{ get zap() { delete this.enumerable; return 0; }, enumerable: true } }); return String(a); }`,
    converts: true,
  },
  {
    id: 'descriptor-held-descriptor-with-an-added-field-copied',
    source: `function frames(error: Error) { const a: any[] = ['safe']; const d: any = { get enumerable() { this.value = error; return true; } }; d.value = 'safe'; Object.defineProperty(a, 0, { ...d }); return String(a); }`,
    converts: true,
  },
  {
    id: 'descriptor-index-beyond-the-last-keeps-its-position-pin',
    source: `function frames(error: Error) { const a: any[] = ['safe']; Object.defineProperty(a, 0, { ...{ value: 'safe', get 4294967295() { this.value = error; return true; } } }); return String(a); }`,
    converts: false,
  },
  {
    id: 'descriptor-index-getter-runs-before-the-fields',
    source: `function frames(error: Error) { const a: any[] = ['safe']; Object.defineProperty(a, 0, { ...{ value: 'safe', get 7() { this.value = error; return true; } } }); return String(a); }`,
    converts: true,
  },
  {
    id: 'descriptor-value-accessor-swallows-the-write-pin',
    source: `function frames(error: Error) { const a: any[] = ['safe']; Object.defineProperty(a, 0, { get enumerable() { this.value = error; return true; }, get value() { return 'safe'; }, set value(v: unknown) {} }); return String(a); }`,
    converts: false,
  },
  {
    id: 'descriptor-grandparent-getter-hidden-by-own-attribute-pin',
    source: `function frames(error: Error) { const a: any[] = ['safe']; Object.defineProperty(a, 0, { __proto__: { __proto__: { get enumerable() { delete this.value; this.get = () => error; return true; } } }, enumerable: true, value: 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'descriptor-proto-null-spread-keeps-the-getter',
    source: `function frames(error: Error, key: string) { const a: any[] = ['safe']; Object.defineProperty(a, 0, { ...{ get __proto__() { this.value = error; return 0; }, value: 'safe', ...{ __proto__: null } } }); return String(a); }`,
    converts: true,
  },
  {
    id: 'descriptor-deleting-getter-keeps-the-assignment',
    source: `function frames(error: Error, key: string) { const a: any[] = ['safe']; Object.defineProperty(a, 0, { get enumerable() { delete this.value; this.value = error; return true; }, get value() { return 'safe'; } }); return String(a); }`,
    converts: true,
  },
  {
    id: 'descriptor-unknown-key-write-after-the-value-was-read-pin',
    source: `function frames(error: Error, key: string) { const a: any[] = ['safe']; Object.defineProperty(a, 0, { value: 'safe', get writable() { this[key] = error; return true; } }); return String(a); }`,
    converts: false,
  },
  {
    id: 'descriptor-unknown-key-write-before-the-value-is-read',
    source: `function frames(error: Error, key: string) { const a: any[] = ['safe']; Object.defineProperty(a, 0, { get enumerable() { this[key] = error; return true; }, value: 'safe' }); return String(a); }`,
    converts: true,
  },
  {
    id: 'descriptor-prototype-read-inherited-then-direct-stays-refused',
    source: `function frames(error: Error) { const a: any[] = ['safe', 'safe']; const p: any = { get enumerable() { this.value = error; return true; }, get value() { return 'safe'; }, set value(v: unknown) {} }; Object.defineProperties(a, { 0: { __proto__: p }, 1: p }); return String(a); }`,
    converts: true,
  },
  {
    id: 'descriptor-prototype-read-direct-then-inherited-stays-refused',
    source: `function frames(error: Error) { const a: any[] = ['safe', 'safe']; const p: any = { get enumerable() { this.value = error; return true; }, get value() { return 'safe'; }, set value(v: unknown) {} }; Object.defineProperties(a, { 0: p, 1: { __proto__: p } }); return String(a); }`,
    converts: true,
  },
  {
    id: 'descriptor-spread-before-a-value-accessor-swallows-the-write',
    source: `function frames(error: Error, key: string) { const a: any[] = ['safe']; Object.defineProperty(a, 0, { ...{}, get enumerable() { this.value = error; return true; }, get value() { return 'safe'; }, set value(v: unknown) {} }); return String(a); }`,
    converts: false,
  },
  {
    id: 'descriptor-computed-proto-spread-replaces-the-getter',
    source: `function frames(error: Error, key: string) { const a: any[] = ['safe']; Object.defineProperty(a, 0, { ...{ get __proto__() { this.value = error; return 0; }, value: 'safe', ...{ ['__proto__']: 0 } } }); return String(a); }`,
    converts: false,
  },
  {
    id: 'refused-descriptor-copied-through-assign',
    source: `function frames(error: Error) { const a = ['safe']; const d: any = { get: () => error }; const c = Object.assign({}, d); Object.defineProperty(a, 0, c); return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-map-copied-through-assign',
    source: `function frames(error: Error) { const a = ['safe']; const m: any = { 0: { get: () => error } }; Object.defineProperties(a, Object.assign({}, m)); return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-safe-descriptor-copied-through-assign-pin',
    source: `function frames(error: Error) { const a = ['safe']; const d: any = { get: () => 'safe' }; const c = Object.assign({}, d); Object.defineProperty(a, 0, c); return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-descriptor-in-a-destructured-alias',
    source: `function frames(error: Error) { const a = ['safe']; const d: any = { get: () => error }; const [x] = [d]; Object.defineProperty(a, 0, x); return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-descriptor-in-an-object-destructured-alias',
    source: `function frames(error: Error) { const a = ['safe']; const d: any = { get: () => error }; const { y } = { y: d }; Object.defineProperty(a, 0, y); return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-assign-to-a-held-descriptor',
    source: `function frames(error: Error) { const a = ['safe']; const d: any = {}; Object.assign(d, { get: () => error }); Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-define-on-a-held-descriptor',
    source: `function frames(error: Error) { const a = ['safe']; const d: any = {}; Object.defineProperty(d, 'get', { value: () => error }); Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-call-on-a-held-list',
    source: `function frames(error: Error) { const a = ['safe']; const am: any[] = []; am.push({ get: () => error }); Object.defineProperties(a, am); return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-assign-to-a-held-map',
    source: `function frames(error: Error) { const a = ['safe']; const m: any = {}; Object.assign(m, { 0: { get: () => error } }); Object.defineProperties(a, m); return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-write-through-a-member-of-a-held-map',
    source: `function frames(error: Error) { const a = ['safe']; const m: any = {}; m[0] = {}; m[0].get = () => error; Object.defineProperties(a, m); return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-write-through-an-entry-of-a-held-list',
    source: `function frames(error: Error) { const a = ['safe']; const l: any[] = [{}]; l[0].get = () => error; Object.defineProperties(a, l); return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-member-of-a-held-map-as-a-descriptor',
    source: `function frames(error: Error) { const a = ['safe']; const m: any = { 0: { get: () => error } }; Object.defineProperty(a, 0, m[0]); return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-member-of-a-held-map-in-a-list',
    source: `function frames(error: Error) { const a = ['safe']; const m: any = { 0: { get: () => error } }; Object.defineProperties(a, [m[0]]); return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-array-handed-to-a-bound-mutator',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign.bind(null)(a, { 0: error }); return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-array-handed-to-a-function-of-the-program',
    source: `function frames(error: Error) { const a = ['safe']; const write = (list: unknown[]) => { list[0] = error; }; write(a); return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-array-held-by-a-literal',
    source: `function frames(error: Error) { const a = ['safe']; const holder = [a]; (holder[0] as unknown[])[0] = error; return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-array-in-a-destructured-alias',
    source: `function frames(error: Error) { const a = ['safe']; const [alias] = [a]; alias[0] = error; return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-array-handed-to-reflect-set',
    source: `function frames(error: Error) { const a = ['safe']; Reflect.set(a, 0, error); return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-array-returned-by-a-mutator-to-a-function',
    source: `function frames(error: Error) { const a = ['safe']; ((list: unknown[]) => { list[0] = error; })(Object.defineProperty(a, 1, { value: 'safe' })); return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-safe-array-handed-to-a-function-pin',
    source: `function frames(error: Error) { const a = ['safe']; const note = (list: unknown[]) => list.length; note(a); return String(a); }`,
    converts: true,
  },
  {
    id: 'known-text-conversion-of-an-array-pin',
    source: `function frames(error: Error) { const a = ['safe']; String(a); return String(a); }`,
    converts: false,
  },
  {
    id: 'known-method-of-an-array-pin',
    source: `function frames(error: Error) { const a = ['safe']; a.push('safe'); return String(a); }`,
    converts: false,
  },
  {
    id: 'known-spread-of-an-array-pin',
    source: `function frames(error: Error) { const a = ['safe']; const b = [...a]; return String(a); }`,
    converts: false,
  },
  {
    id: 'known-length-of-an-array-pin',
    source: `function frames(error: Error) { const a = ['safe']; const n = a.length; return String(a); }`,
    converts: false,
  },
  {
    id: 'known-iteration-of-an-array-pin',
    source: `function frames(error: Error) { const a = ['safe']; for (const each of a) { void each; } return String(a); }`,
    converts: false,
  },
  {
    id: 'known-reader-native-of-an-array-pin',
    source: `function frames(error: Error) { const a = ['safe']; const keys = Object.keys(a); return String(a); }`,
    converts: false,
  },
  {
    id: 'known-test-of-an-array-pin',
    source: `function frames(error: Error) { const a = ['safe']; if (a) { void 0; } return String(a); }`,
    converts: false,
  },
  {
    id: 'known-mutator-of-an-array-pin',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { 0: 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'known-mutator-through-a-comma-pin',
    source: `function frames(error: Error) { const a = ['safe']; (0, Object.defineProperty)(a, 0, { value: 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'known-use-after-the-read-pin',
    source: `function frames(error: Error, write: (list: unknown[]) => void) { const a = ['safe']; const text = String(a); write(a); return text; }`,
    converts: false,
  },
  {
    id: 'refused-pattern-source-with-a-method',
    source: `function frames(error: Error) { const a = ['safe']; const d: any = {}; ({ f: d.get } = { f() { return error; } }); Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-pattern-source-from-a-call',
    source: `function frames(error: Error) { const a = ['safe']; const d: any = {}; ({ f: d.get } = Object.freeze({ f: () => error })); Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-pattern-source-copied-through-assign',
    source: `function frames(error: Error) { const a = ['safe']; const d: any = {}; ({ f: d.get } = Object.assign({}, { f: () => error })); Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-member-of-a-literal-as-a-written-value',
    source: `function frames(error: Error) { const a = ['safe']; const d: any = {}; d.get = ({ f: () => error }).f; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-member-of-a-list-as-a-written-value',
    source: `function frames(error: Error) { const a = ['safe']; const d: any = {}; d.get = [() => error][0]; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'refused-member-of-a-literal-in-a-pattern-source',
    source: `function frames(error: Error) { const a = ['safe']; const d: any = {}; ({ x: d.get } = { x: ({ f: () => error }).f }); Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'known-pattern-source-literal-pin',
    source: `function frames(error: Error) { const a = ['safe']; const d: any = {}; ({ f: d.get } = { f: () => 'safe' }); Object.defineProperty(a, 0, d); return String(a); }`,
    converts: false,
  },
  {
    id: 'known-pattern-source-held-constant-pin',
    source: `function frames(error: Error) { const a = ['safe']; const d: any = {}; const s = { f: () => 'safe' }; ({ f: d.get } = s); Object.defineProperty(a, 0, d); return String(a); }`,
    converts: false,
  },
  {
    id: 'known-written-function-pin',
    source: `function frames(error: Error) { const a = ['safe']; const d: any = {}; const read = () => 'safe'; d.get = read; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: false,
  },
  {
    id: 'known-written-function-through-error-pin',
    source: `function frames(error: Error) { const a = ['safe']; const d: any = {}; const read = () => error; d.get = read; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'push-bound-through-a-spread-receiver-refused',
    source: `function frames(error: Error) { const values: any[] = ['safe']; const push = Array.prototype.push.bind(...([values] as [any[]])); push(error); return String(values); }`,
    converts: true,
  },
  {
    id: 'aliased-native-mutator-of-a-list-followed',
    source: `function frames(error: Error) { const list: any[] = ['safe']; const assign = Object.assign; assign(list, { 0: error }); return String(list); }`,
    converts: true,
  },
  {
    id: 'bound-native-mutator-of-a-list-refused',
    source: `function frames(error: Error) { const list: any[] = ['safe']; Object.assign.bind(null)(list, { 0: error }); return String(list); }`,
    converts: true,
  },
  {
    id: 'call-call-native-mutator-of-a-list-refused',
    source: `function frames(error: Error) { const list: any[] = ['safe']; Function.prototype.call.call(Object.assign, null, list, { 0: error }); return String(list); }`,
    converts: true,
  },
  {
    id: 'held-list-written-through-a-parenthesized-method-refused',
    source: `function frames(error: Error) { const a: any[] = ['safe']; const descriptor: PropertyDescriptor = {}; const list: any[] = []; (list.push)(() => error); [descriptor.get] = list; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'held-list-written-through-an-element-method-refused',
    source: `function frames(error: Error) { const a: any[] = ['safe']; const descriptor: PropertyDescriptor = {}; const list: any[] = []; list['push'](() => error); [descriptor.get] = list; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'element-written-through-an-alias-assigned-later-refused',
    source: `function frames(error: Error) { const a: any[] = ['safe']; let b: any[] = []; b = a; b[0] = error; return String(a); }`,
    converts: true,
  },
  {
    id: 'descriptor-held-by-a-destructured-constant-refused',
    source: `function frames(error: Error) { const a: any[] = ['safe']; const { descriptor } = { descriptor: { get: () => error } }; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'descriptor-held-by-an-array-destructured-constant-refused',
    source: `function frames(error: Error) { const a: any[] = ['safe']; const [descriptor] = [{ get: () => error }]; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: true,
  },
  {
    id: 'alias-write-then-logical-assign-runs',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const s: any = { f: () => 'safe' }; let alias = s; alias.f = undefined; alias = {}; s.f ||= () => error; const { f: read } = s; Object.defineProperty(a, 0, { get: read }); return String(a); }`,
    converts: true,
  },
  {
    id: 'followed-alias-write-then-logical-assign-runs',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const s: any = { f: () => 'safe' }; const alias = s; alias.f = undefined; s.f ||= () => error; const { f: read } = s; Object.defineProperty(a, 0, { get: read }); return String(a); }`,
    converts: true,
  },
  {
    id: 'alias-never-written-logical-assign-skipped-pin',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const s: any = { f: () => 'safe' }; const alias = s; void alias; s.f ||= () => error; const { f: read } = s; Object.defineProperty(a, 0, { get: read }); return String(a); }`,
    converts: false,
  },
  {
    id: 'container-holds-the-object-logical-assign-runs',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const s: any = { f: () => 'safe' }; const holder = { s }; holder.s.f = undefined; s.f ||= () => error; const { f: read } = s; Object.defineProperty(a, 0, { get: read }); return String(a); }`,
    converts: true,
  },
  {
    id: 'c1-container-value-alias',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { get: () => 'safe' }; const holder = { value: d }; const x = holder.value; x.get = undefined; d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'c1b-container-length-alias',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { get: () => 'safe' }; const holder = { length: d }; const x = holder.length; x.get = undefined; d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'c1c-box-alias-written-through',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { get: () => 'safe' }; const holder = { value: d }; const x = holder.value; x.get = () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'c1d-box-length-alias-written-through',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { value: 'safe' }; const holder = { length: d }; const x = holder.length; x.value = error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'c2-arithmetic-coerces-descriptor',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { valueOf() { this.get = undefined; return 0; }, get: () => 'safe' }; ({}) + d; d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'c2b-pattern-assignment-stays-known-pin',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { get: () => 'safe' }; const { get: read } = d; Object.defineProperty(a, 0, { get: read }); return String(a); }`,
    converts: false,
  },
  {
    id: 's1-element-callback',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = ['safe']; values.forEach((_: any, __: any, array: any[]) => { array.push(error); }); return String(values); }`,
    converts: true,
  },
  {
    id: 's1b-element-callback-map',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = ['safe']; values.map((_: any, __: any, array: any[]) => array.push(error)); return String(values); }`,
    converts: true,
  },
  {
    id: 's1c-element-callback-reduce',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = ['safe']; values.reduce((acc: any, _: any, __: any, array: any[]) => array.push(error), 0); return String(values); }`,
    converts: true,
  },
  {
    id: 's1d-element-callback-named',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = ['safe']; const add = (_: any, __: any, array: any[]) => { array.push(error); }; values.forEach(add); return String(values); }`,
    converts: true,
  },
  {
    id: 's1e-element-callback-two-params-pin',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = ['safe']; values.forEach((item: any, index: number) => { void item; void index; }); return String(values); }`,
    converts: false,
  },
  {
    id: 's1f-element-callback-written-out-of-reach-pin',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = ['safe']; values.filter(Boolean); return String(values); }`,
    converts: false,
  },
  {
    id: 'native-reader-given-the-object-as-a-key-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { toString() { this.get = undefined; return 'key'; }, get: () => 'safe' }; Object.getOwnPropertyDescriptor({}, d); d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'native-reader-given-the-object-first-pin',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { get: () => 'safe' }; Object.getOwnPropertyDescriptor(d, 'get'); d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: false,
  },
  {
    id: 'write-through-a-choice-of-receivers-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { get: () => 'safe' }; (flag ? d : d).get = undefined; d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'borrowed-join-of-the-array-pin',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; return Array.prototype.join.call(a); }`,
    converts: false,
  },
  {
    id: 'borrowed-push-onto-the-array',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; Array.prototype.push.call(a, error); return String(a); }`,
    converts: true,
  },
  {
    id: 'borrowed-map-handing-the-array-to-a-callback-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; Array.prototype.map.call(a, (_: any, __: any, arr: any[]) => arr.push(error)); return String(a); }`,
    converts: true,
  },
  {
    id: 'borrowed-apply-with-a-callback-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; Array.prototype.forEach.apply(a, [(_: any, __: any, arr: any[]) => { arr.push(error); }] as any); return String(a); }`,
    converts: true,
  },
  {
    id: 'borrowed-slice-of-the-array-pin',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const copy = Array.prototype.slice.call(a); void copy; return String(a); }`,
    converts: false,
  },
  {
    id: 'unknown-use-in-a-branch-that-cannot-run-pin',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const write = (x: any[]) => x.push(error); if (false) write(a); return String(a); }`,
    converts: false,
  },
  {
    id: 'element-of-at-written-through-a-member-stays-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = [{ v: 'safe' }]; (a.at(0) as any).v = error; return String(a); }`,
    converts: true,
  },
  {
    id: 'element-of-find-called-through-a-member-stays-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = [{ add() { this.push(error); } }]; a.find((x: any) => x)?.add(); return String(a); }`,
    converts: true,
  },
  {
    id: 'element-of-at-read-through-a-member-pin',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = [{ v: 'safe' }]; const m = (a.at(0) as any).v; void m; return String(a); }`,
    converts: false,
  },
  {
    id: 'pop-discarded-pin',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; a.pop(); return String(a); }`,
    converts: false,
  },
  {
    id: 'borrowed-push-through-a-comma-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; (0, Array.prototype.push).call(a, error); return String(a); }`,
    converts: true,
  },
  {
    id: 'borrowed-push-through-a-constant-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const push = Array.prototype.push; push.call(a, error); return String(a); }`,
    converts: true,
  },
  {
    id: 'borrowed-push-written-whole',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; Array.prototype.push.call(a, error); return String(a); }`,
    converts: true,
  },
  {
    id: 'held-iterator-spread-in-a-statement-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { *[Symbol.iterator]() { this.get = undefined; yield [1, 2]; }, get: () => 'safe' }; [...d]; d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'held-iterator-spread-of-a-choice-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { *[Symbol.iterator]() { this.get = undefined; yield [1, 2]; }, get: () => 'safe' }; [...(flag ? d : [])]; d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'held-iterator-spread-of-a-logical-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { *[Symbol.iterator]() { this.get = undefined; yield [1, 2]; }, get: () => 'safe' }; [...(d || [])]; d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'held-iterator-array-pattern-assignment-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { *[Symbol.iterator]() { this.get = undefined; yield [1, 2]; }, get: () => 'safe' }; let q: any; [q] = d; void q; d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'held-iterator-array-pattern-declaration-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { *[Symbol.iterator]() { this.get = undefined; yield [1, 2]; }, get: () => 'safe' }; const [q] = d; void q; d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'held-iterator-spread-kept-stays-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { *[Symbol.iterator]() { this.get = undefined; yield [1, 2]; }, get: () => 'safe' }; const x = [...d]; void x; d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'held-iterator-spread-into-call-arguments-stays-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { *[Symbol.iterator]() { this.get = undefined; yield [1, 2]; }, get: () => 'safe' }; Math.max(...d); d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'held-iterator-loop-stays-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { *[Symbol.iterator]() { this.get = undefined; yield [1, 2]; }, get: () => 'safe' }; for (const x of d) { void x; } d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'held-iterator-array-from-stays-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { *[Symbol.iterator]() { this.get = undefined; yield [1, 2]; }, get: () => 'safe' }; Array.from(d); d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'held-iterator-map-stays-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { *[Symbol.iterator]() { this.get = undefined; yield [1, 2]; }, get: () => 'safe' }; new Map(d); d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'held-iterator-delegation-stays-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { *[Symbol.iterator]() { this.get = undefined; yield [1, 2]; }, get: () => 'safe' }; const g = function* () { yield* d; }; for (const x of g()) { void x; } d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'held-iterator-nested-pattern-stays-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { *[Symbol.iterator]() { this.get = undefined; yield [1, 2]; }, get: () => 'safe' }; const [[q]] = [d]; void q; d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'held-object-spread-pin',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { get: () => 'safe' }; const c = { ...d }; void c; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: false,
  },
  {
    id: 'held-object-pattern-pin',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { get: () => 'safe' }; const { get } = d; void get; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: false,
  },
  {
    id: 'held-list-spread-pin',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const l: any[] = [1, 2]; [...l]; Object.defineProperty(a, 0, { get: () => 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'array-spread-pin',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; [...a]; return String(a); }`,
    converts: false,
  },
  {
    id: 'held-key-of-a-choice-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { toString() { this.get = undefined; return '0'; }, get: () => 'safe' }; Object.defineProperty(a, flag ? d : d, { value: 'safe', configurable: true }); d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'held-key-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { toString() { this.get = undefined; return '0'; }, get: () => 'safe' }; Object.defineProperty(a, d, { value: 'safe', configurable: true }); d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'held-key-with-a-value-of-method-stays-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { valueOf() { this.get = undefined; return 0; }, get: () => 'safe' }; Object.defineProperty(a, d, { value: 'safe', configurable: true }); d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'held-key-with-a-to-primitive-method-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { [Symbol.toPrimitive]() { this.get = undefined; return '0'; }, get: () => 'safe' }; Object.defineProperty(a, d, { value: 'safe', configurable: true }); d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'held-key-through-call-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { toString() { this.get = undefined; return '0'; }, get: () => 'safe' }; Object.defineProperty.call(Object, a, d, { value: 'safe', configurable: true }); d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'held-key-through-apply-stays-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { toString() { this.get = undefined; return '0'; }, get: () => 'safe' }; Object.defineProperty.apply(Object, [a, d, { value: 'safe', configurable: true }]); d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'held-key-through-reflect-apply-stays-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { toString() { this.get = undefined; return '0'; }, get: () => 'safe' }; Reflect.apply(Object.defineProperty, Object, [a, d, { value: 'safe', configurable: true }]); d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'held-key-of-reflect-define-property-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { toString() { this.get = undefined; return '0'; }, get: () => 'safe' }; Reflect.defineProperty(a, d, { value: 'safe', configurable: true }); d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: true,
  },
  {
    id: 'held-descriptor-in-a-map-pin',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const d: any = { toString() { this.get = undefined; return '0'; }, get: () => 'safe' }; Object.defineProperties(a, { 0: d }); d.get ??= () => error; Object.defineProperty(a, 0, d); return String(a); }`,
    converts: false,
  },
  {
    id: 'array-as-a-key-pin',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const k: any[] = ['safe']; Object.defineProperty(a, k, { value: 'x' }); return String(k); }`,
    converts: false,
  },
  {
    id: 'json-replacer-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; JSON.stringify(a, (k: string, v: any) => { if (k === '') v[0] = error; return v; }); return String(a); }`,
    converts: true,
  },
  {
    id: 'json-replacer-held-in-a-constant-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; const r = (k: string, v: any) => { if (k === '') v[0] = error; return v; }; JSON.stringify(a, r); return String(a); }`,
    converts: true,
  },
  {
    id: 'json-replacer-function-expression-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; JSON.stringify(a, function (this: any, k: string, v: any) { if (k === '') v[0] = error; return v; }); return String(a); }`,
    converts: true,
  },
  {
    id: 'json-undefined-replacer-stays-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; JSON.stringify(a, undefined, 2); return String(a); }`,
    converts: true,
  },
  {
    id: 'json-allowlist-replacer-stays-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; JSON.stringify(a, ['0']); return String(a); }`,
    converts: true,
  },
  {
    id: 'json-null-replacer-pin',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; JSON.stringify(a, null, 2); return String(a); }`,
    converts: false,
  },
  {
    id: 'json-plain-pin',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; JSON.stringify(a); return String(a); }`,
    converts: false,
  },
  {
    id: 'json-replacer-on-a-mutator-answer-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; JSON.stringify(Object.assign(a, {}), (k: string, v: any) => { if (k === '') v[0] = error; return v; }); return String(a); }`,
    converts: true,
  },
  {
    id: 'json-replacer-on-a-define-property-answer-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; JSON.stringify(Object.defineProperty(a, 'x', { value: 1 }), (k: string, v: any) => { if (k === '') v[0] = error; return v; }); return String(a); }`,
    converts: true,
  },
  {
    id: 'json-replacer-on-a-reverse-answer-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; JSON.stringify(a.reverse(), (k: string, v: any) => { if (k === '') v[0] = error; return v; }); return String(a); }`,
    converts: true,
  },
  {
    id: 'json-replacer-on-a-fill-answer-refused',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; JSON.stringify(a.fill(1), (k: string, v: any) => { if (k === '') v[0] = error; return v; }); return String(a); }`,
    converts: true,
  },
  {
    id: 'json-mutator-answer-without-a-replacer-pin',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; JSON.stringify(Object.assign(a, {})); return String(a); }`,
    converts: false,
  },
  {
    id: 'json-mutator-answer-with-a-null-replacer-pin',
    source: `function frames(error: Error, flag: boolean) { const a: any[] = ['safe']; JSON.stringify(Object.assign(a, {}), null, 2); return String(a); }`,
    converts: false,
  },
  {
    id: 'replaced-alias-of-an-array-is-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = []; let alias = values; alias = [error]; return String(alias); }`,
    converts: true,
  },
  {
    id: 'replaced-alias-through-a-chain-is-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = ['safe']; const first = values; let alias = first; alias = [error]; return String(alias); }`,
    converts: true,
  },
  {
    id: 'alias-replaced-after-a-read-is-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = ['safe']; let alias = values; const text = String(alias); alias = [error]; return text + String(alias); }`,
    converts: true,
  },
  {
    id: 'alias-replaced-in-a-branch-is-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = ['safe']; let alias = values; if (flag) { alias = [error]; } return String(alias); }`,
    converts: true,
  },
  {
    id: 'replaced-alias-with-a-mutator-target-is-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = ['safe']; let alias = values; alias = [error]; Object.assign(alias, {}); return String(alias); }`,
    converts: true,
  },
  {
    id: 'alias-replaced-by-the-array-itself-stays-refused',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = ['safe']; let alias = values; alias = values; return String(alias); }`,
    converts: true,
  },
  {
    id: 'constant-alias-of-an-array-pin',
    source: `function frames(error: Error, flag: boolean) { const values: any[] = ['safe']; const alias = values; return String(alias); }`,
    converts: false,
  },
  {
    id: 'assign-getter-writes-later-slot',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { get 0() { this[1] = error; return 'safe'; }, 1: 'safe' }); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-getter-hidden-result-still-writes',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { ...{ get 0() { this[1] = error; return 'safe'; }, 1: 'safe' }, 0: 'kept' }); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-getter-write-overwritten-by-later-field-adds-nothing',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { ...{ get 0() { this[1] = error; return 'safe'; }, 1: 'old' }, 1: 'kept' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-getter-writes-computed-slot',
    source: `function frames(error: Error, key: string) { const a = ['safe']; Object.assign(a, { get 0() { this[key] = error; return 1; }, 1: 'safe' }); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-getter-of-unknown-name-writes-later-slot',
    source: `function frames(error: Error, key: string) { const a = ['safe']; Object.assign(a, { get [key]() { this[1] = error; return 1; }, 1: 'safe' }); return String(a); }`,
    converts: true,
  },
  {
    id: 'assign-getter-writes-an-earlier-slot-adds-nothing-pin',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { get 1() { this[0] = error; return 1; }, 0: 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-string-named-getter-writes-slot-adds-nothing-pin',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { get probe() { this[1] = error; return 1; }, 1: 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-getter-deletes-through-this-adds-nothing-pin',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { get 0() { delete this[1]; return 1; }, 1: 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-getter-replaced-in-its-own-literal-never-runs-pin',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { get 0() { this[1] = error; return 1; }, 0: 2, 1: 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'assign-getter-writes-a-named-field-adds-nothing-pin',
    source: `function frames(error: Error) { const a = ['safe']; Object.assign(a, { get 0() { this.label = error; return 1; }, 1: 'safe' }); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-map-getter-writes-later-descriptor',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperties(a, { get 0() { this[1] = { value: error }; return { value: 'safe' }; }, 1: { value: 'safe' } }); return String(a); }`,
    converts: true,
  },
  {
    id: 'define-map-getter-writes-an-earlier-descriptor-adds-nothing-pin',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperties(a, { get 1() { this[0] = { value: error }; return { value: 'safe' }; }, 0: { value: 'safe' } }); return String(a); }`,
    converts: false,
  },
  {
    id: 'define-map-string-named-getter-adds-nothing-pin',
    source: `function frames(error: Error) { const a = ['safe']; Object.defineProperties(a, { get probe() { this[1] = { value: error }; return { value: 'safe' }; }, 1: { value: 'safe' } }); return String(a); }`,
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
