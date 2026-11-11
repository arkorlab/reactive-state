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
    elements: ['keys:1.value', 'more:0.value', 'error:'],
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
    id: 'define-reassigned-alias-write-safe',
    source: `function frames(error: Error) { const a = ['safe']; const descriptor: PropertyDescriptor = { get: () => 'safe' }; let alias = descriptor; alias = {}; alias.get = () => error; Object.defineProperty(a, 0, descriptor); return String(a); }`,
    converts: false,
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
