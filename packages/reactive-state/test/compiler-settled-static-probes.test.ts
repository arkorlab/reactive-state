import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Builds the refusal reason reported when probing the global object for `what`. */
function globalProbeRefusal(what: string): string {
  return `tests whether the global object holds ${what}, which tells where it runs`;
}

/**
 * Static and bracketed global ownership probes expose host-specific globals just like `in` and
 * direct `.hasOwnProperty(...)`, while universal built-ins and ordinary local objects stay settled.
 */
const CASES = [
  {
    expected: globalProbeRefusal('`process`'),
    id: 'object-has-own-process',
    source: "export function isNode() { return Object.hasOwn(globalThis, 'process'); }",
  },
  {
    expected: globalProbeRefusal('`document`'),
    id: 'object-has-own-window-document',
    source: "export function isBrowser() { return Object.hasOwn(window, 'document'); }",
  },
  {
    expected: globalProbeRefusal('`process`'),
    id: 'reflect-has-process',
    source: "export function isNode() { return Reflect.has(globalThis, 'process'); }",
  },
  {
    expected: globalProbeRefusal('`SharedArrayBuffer`'),
    id: 'reflect-has-shared-array-buffer',
    source:
      "export function hasSharedMemory() { return Reflect.has(globalThis, 'SharedArrayBuffer'); }",
  },
  {
    expected: globalProbeRefusal('`process`'),
    id: 'object-get-own-property-descriptor',
    source:
      "export function hasProcess() { return Object.getOwnPropertyDescriptor(globalThis, 'process') !== undefined; }",
  },
  {
    expected: globalProbeRefusal('`SharedArrayBuffer`'),
    id: 'reflect-get-own-property-descriptor',
    source:
      "export function hasShared() { return Reflect.getOwnPropertyDescriptor(globalThis, 'SharedArrayBuffer') !== undefined; }",
  },
  {
    expected: globalProbeRefusal('`process`'),
    id: 'prototype-has-own-property-call',
    source:
      "export function isNode() { return Object.prototype.hasOwnProperty.call(globalThis, 'process'); }",
  },
  {
    expected: globalProbeRefusal('`process`'),
    id: 'prototype-property-is-enumerable-call',
    source:
      "export function isNode() { return Object.prototype.propertyIsEnumerable.call(globalThis, 'process'); }",
  },
  {
    expected: globalProbeRefusal('`process`'),
    id: 'bracketed-has-own-property',
    source: "export function isNode() { return globalThis['hasOwnProperty']('process'); }",
  },
  {
    expected: globalProbeRefusal('a name it computes'),
    id: 'object-has-own-computed-key',
    source: 'export function hasGlobal(key: string) { return Object.hasOwn(globalThis, key); }',
  },
  {
    expected: undefined,
    id: 'object-has-own-map-pin',
    source: "export function hasMap() { return Object.hasOwn(globalThis, 'Map'); }",
  },
  {
    expected: undefined,
    id: 'reflect-has-date-pin',
    source: "export function hasDate() { return Reflect.has(globalThis, 'Date'); }",
  },
  {
    expected: undefined,
    id: 'object-has-own-local-holder-pin',
    source:
      "export function hasLocal(box: Record<string, unknown>) { return Object.hasOwn(box, 'process'); }",
  },
  {
    expected: 'reads `window`, a global of chance, of the time or of where it runs',
    id: 'object-has-own-window-map-pin',
    source: "export function hasWindowMap() { return Object.hasOwn(window, 'Map'); }",
  },
  {
    expected: globalProbeRefusal('`process`'),
    id: 'in-operator-process-pin',
    source: "export function isNode() { return 'process' in globalThis; }",
  },
] as const;

describe('static and bracketed global ownership probes', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` for a candidate shared helper module. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'settled-static-probes.ts', source);
    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
