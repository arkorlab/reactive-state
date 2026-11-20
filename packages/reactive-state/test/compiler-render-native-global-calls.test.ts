import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renderLocalInput } from '../src/compiler/render-local-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DATE_TEXT = 'writes a date as text of the time zone where it runs';

const VALUE = '(_s:TemplateStringsArray,value:unknown)=>';
const REST = '(_s:TemplateStringsArray,...values:unknown[])=>';
const OPEN = '${';
const ONE = `tag\`${OPEN}new Date(0)}\``;

/**
 * A native function or constructor of the language's globals that the walk does not resolve to
 * source and that is not known to leave a Date alone is handed a Date as text, or as a key, of the
 * time zone where it runs: `encodeURIComponent(date)` is `Thu%20Jan%2001%201970%2000%3A00%3A00...`
 * under UTC and `Wed%20Dec%2031%201969%2019%3A00%3A00...` under America/New_York. What it leaves
 * alone is the list of deterministic natives (`Number`, `Boolean`, `isNaN`, `isFinite`, `Math`,
 * `JSON.stringify`, `Object.is`, `Array`, `Date`, `BigInt`, `structuredClone`, `Object.freeze`,
 * `console`, `Promise`, timers, and the collections `Set`, `Map`, `WeakSet`, `WeakMap`).
 */
const CASES = [
  {
    id: 'encodeURIComponent',
    tag: `${VALUE}encodeURIComponent(value as string)`,
    local: DATE_TEXT,
  },
  { id: 'encodeURI', tag: `${VALUE}encodeURI(value as string)`, local: DATE_TEXT },
  {
    id: 'decodeURIComponent',
    tag: `${VALUE}decodeURIComponent(value as string)`,
    local: DATE_TEXT,
  },
  { id: 'escape', tag: `${VALUE}escape(value as string)`, local: DATE_TEXT },
  { id: 'btoa', tag: `${VALUE}btoa(value as string)`, local: DATE_TEXT },
  { id: 'parseInt', tag: `${VALUE}parseInt(value as string)`, local: DATE_TEXT },
  { id: 'parseFloat', tag: `${VALUE}parseFloat(value as string)`, local: DATE_TEXT },
  { id: 'Number-parseInt', tag: `${VALUE}Number.parseInt(value as string)`, local: DATE_TEXT },
  { id: 'new-URL', tag: `${VALUE}new URL(value as string).href`, local: DATE_TEXT },
  { id: 'new-RegExp', tag: `${VALUE}new RegExp(value as string).source`, local: DATE_TEXT },
  { id: 'new-Error', tag: `${VALUE}new Error(value as string).message`, local: DATE_TEXT },
  { id: 'Symbol', tag: `${VALUE}Symbol(value as string).description`, local: DATE_TEXT },
  {
    id: 'Object-hasOwn-by-the-date',
    tag: `${VALUE}Object.hasOwn({},value as string)`,
    local: DATE_TEXT,
  },
  {
    id: 'Reflect-has-by-the-date',
    tag: `${VALUE}Reflect.has({},value as string)`,
    local: DATE_TEXT,
  },
  {
    id: 'Object-keys-of-the-substitutions',
    tag: `${REST}Object.keys(values).join('')`,
    local: DATE_TEXT,
  },
  {
    id: 'encodeURIComponent-of-a-rest-substitution',
    tag: `${REST}encodeURIComponent(values[0] as string)`,
    local: DATE_TEXT,
  },
  {
    id: 'encodeURIComponent-in-a-template',
    tag: `${VALUE}\`/api?since=${OPEN}encodeURIComponent(value as string)}\``,
    local: DATE_TEXT,
  },
  {
    id: 'encodeURIComponent-in-a-callback',
    tag: `${REST}values.map((each)=>encodeURIComponent(each as string)).join('&')`,
    local: DATE_TEXT,
  },
  {
    id: 'encodeURIComponent-of-a-kept-date',
    tag: `${VALUE}{const since=value as string;return encodeURIComponent(since);}`,
    local: DATE_TEXT,
  },
  {
    id: 'encodeURIComponent-through-globalThis',
    tag: `${VALUE}globalThis.encodeURIComponent(value as string)`,
    local: DATE_TEXT,
  },
  { id: 'Number-pin', tag: `${VALUE}String(Number(value))`, local: undefined },
  { id: 'Boolean-pin', tag: `${VALUE}String(Boolean(value))`, local: undefined },
  { id: 'isNaN-pin', tag: `${VALUE}String(isNaN(value as number))`, local: undefined },
  { id: 'isFinite-pin', tag: `${VALUE}String(isFinite(value as number))`, local: undefined },
  {
    id: 'Math-max-of-times-pin',
    tag: `${VALUE}String(Math.max(+(value as Date),0))`,
    local: undefined,
  },
  {
    id: 'Math-max-of-the-date-pin',
    tag: `${VALUE}String(Math.max(value as number,0))`,
    local: undefined,
  },
  { id: 'JSON-stringify-pin', tag: `${VALUE}JSON.stringify(value)`, local: undefined },
  { id: 'Object-is-pin', tag: `${VALUE}String(Object.is(value,value))`, local: undefined },
  { id: 'Array-isArray-pin', tag: `${VALUE}String(Array.isArray(value))`, local: undefined },
  {
    id: 'new-Date-of-the-date-pin',
    tag: `${VALUE}new Date(value as Date).getTime()`,
    local: undefined,
  },
  { id: 'BigInt-pin', tag: `${VALUE}String(BigInt(value as number))`, local: undefined },
  {
    id: 'new-Set-of-the-substitutions-pin',
    tag: `${REST}String(new Set(values).size)`,
    local: undefined,
  },
  {
    id: 'new-Map-of-a-pair-pin',
    tag: `${VALUE}String(new Map([[value,1]]).size)`,
    local: undefined,
  },
  {
    id: 'structuredClone-pin',
    tag: `${VALUE}String(structuredClone(value)===value)`,
    local: undefined,
  },
  { id: 'console-log-pin', tag: `${VALUE}{console.log(value);return 'x';}`, local: undefined },
  {
    id: 'Promise-resolve-pin',
    tag: `${VALUE}{Promise.resolve(value);return 'x';}`,
    local: undefined,
  },
  {
    id: 'Object-freeze-pin',
    tag: `${REST}String(Object.isFrozen(Object.freeze(values)))`,
    local: undefined,
  },
  {
    id: 'setTimeout-delayed-by-the-date-pin',
    tag: `${VALUE}{setTimeout(()=>1,value as number);return 'x';}`,
    local: undefined,
  },
  {
    id: 'encodeURIComponent-of-the-iso-text-pin',
    tag: `${VALUE}encodeURIComponent((value as Date).toISOString())`,
    local: undefined,
  },
  {
    id: 'encodeURIComponent-of-the-time-pin',
    tag: `${VALUE}encodeURIComponent(String((value as Date).getTime()))`,
    local: undefined,
  },
  {
    id: 'parseInt-of-a-literal-pin',
    tag: `${VALUE}String(parseInt('12',10))+String((value as Date).getTime())`,
    local: undefined,
  },
  {
    id: 'own-parseInt-pin',
    tag: `${VALUE}{const parseInt=(_text:unknown)=>1;return String(parseInt(value));}`,
    local: undefined,
  },
] as const;

describe('a Date a tag hands to a native function or constructor of the globals', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ tag, local }) => {
    const source = `export function Widget(){const tag=${tag};return <p>{${ONE}}</p>;}`;

    expect(firstLocalInput(api, source)).toBe(local);
  });
});

function firstLocalInput(api: API, source: string): string | undefined {
  using parsed = parseModule(api, 'render-native-global-calls.tsx', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    const found = renderLocalInput(node);
    if (found !== undefined) return found;
    const children: Node[] = [];
    node.forEachChild((child) => {
      children.push(child);
    });
    pending.push(...children.toReversed());
  }
  return undefined;
}
