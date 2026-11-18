import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renderLocalInput } from '../src/compiler/render-local-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DATE_TEXT = 'writes a date as text of the time zone where it runs';

const REST = '(_s:TemplateStringsArray,...values:unknown[])=>';
const ONE = `tag\`\${new Date(0)}\``;

/**
 * Every array method that calls a callback with the elements of its receiver reads a Date a tag is
 * handed through that callback, written in place or named, and through the array it hands the
 * callback after the index. The methods that answer an element or a flag, `find` and `findIndex`
 * and their `Last` forms, `some`, `every`, `filter`, `map`, `flatMap`, `forEach`, the reductions,
 * the sorts and `Array.from`, are one list: a method left out is taken whatever its callback writes.
 */
const ELEMENT_METHODS = [
  'every',
  'filter',
  'find',
  'findIndex',
  'findLast',
  'findLastIndex',
  'flatMap',
  'forEach',
  'map',
  'some',
] as const;
const REDUCTIONS = ['reduce', 'reduceRight'] as const;
const SORTS = ['sort', 'toSorted'] as const;

interface Row {
  readonly id: string;
  readonly tag: string;
  readonly local: string | undefined;
}

const ROWS: readonly Row[] = [
  ...ELEMENT_METHODS.flatMap((method): Row[] => {
    return [
      {
        id: `${method}-callback-writes-the-element-as-text`,
        tag: `${REST}values.${method}((value)=>String(value)==='x')`,
        local: DATE_TEXT,
      },
      {
        id: `${method}-named-callback-writes-the-element-as-text`,
        tag: `${REST}{const text=(value:unknown)=>String(value)==='x';return values.${method}(text);}`,
        local: DATE_TEXT,
      },
      {
        id: `${method}-callback-writes-the-array-as-text`,
        tag: `${REST}values.${method}((_value,_index,all)=>all.join(',')==='x')`,
        local: DATE_TEXT,
      },
      {
        id: `${method}-named-callback-writes-the-array-as-text`,
        tag: `${REST}{const text=(_value:unknown,_index:number,all:unknown[])=>all.join(',')==='x';return values.${method}(text);}`,
        local: DATE_TEXT,
      },
      {
        id: `${method}-callback-reads-the-time-pin`,
        tag: `${REST}values.${method}((value)=>(value as Date).getTime()>0)`,
        local: undefined,
      },
      {
        id: `${method}-named-callback-reads-the-time-pin`,
        tag: `${REST}{const later=(value:unknown)=>(value as Date).getTime()>0;return values.${method}(later);}`,
        local: undefined,
      },
      {
        id: `${method}-callback-reads-the-length-pin`,
        tag: `${REST}values.${method}((_value,index,all)=>index<all.length)`,
        local: undefined,
      },
    ];
  }),
  ...REDUCTIONS.flatMap((method): Row[] => {
    return [
      {
        id: `${method}-callback-writes-the-element-as-text`,
        tag: `${REST}values.${method}((text,value)=>text+String(value),'')`,
        local: DATE_TEXT,
      },
      {
        id: `${method}-named-callback-writes-the-element-as-text`,
        tag: `${REST}{const join=(text:string,value:unknown)=>text+String(value);return values.${method}(join,'');}`,
        local: DATE_TEXT,
      },
      {
        id: `${method}-callback-writes-the-array-as-text`,
        tag: `${REST}values.${method}((text,_value,_index,all)=>text+all.join(','),'')`,
        local: DATE_TEXT,
      },
      {
        id: `${method}-callback-reads-the-time-pin`,
        tag: `${REST}values.${method}((total,value)=>total+(value as Date).getTime(),0)`,
        local: undefined,
      },
    ];
  }),
  ...SORTS.flatMap((method): Row[] => {
    return [
      {
        id: `${method}-callback-writes-the-element-as-text`,
        tag: `${REST}values.${method}((a,b)=>(String(a)<String(b)?-1:1))`,
        local: DATE_TEXT,
      },
      {
        id: `${method}-named-callback-writes-the-element-as-text`,
        tag: `${REST}{const order=(a:unknown,b:unknown)=>(String(a)<String(b)?-1:1);return values.${method}(order);}`,
        local: DATE_TEXT,
      },
      {
        id: `${method}-callback-reads-the-time-pin`,
        tag: `${REST}values.${method}((a,b)=>(a as Date).getTime()-(b as Date).getTime())`,
        local: undefined,
      },
    ];
  }),
  {
    id: 'Array-from-callback-writes-the-element-as-text',
    tag: `${REST}Array.from(values,(value)=>String(value))`,
    local: DATE_TEXT,
  },
  {
    id: 'Array-from-named-callback-writes-the-element-as-text',
    tag: `${REST}{const text=(value:unknown)=>String(value);return Array.from(values,text);}`,
    local: DATE_TEXT,
  },
  {
    id: 'Array-from-callback-reads-the-time-pin',
    tag: `${REST}Array.from(values,(value)=>(value as Date).getTime())`,
    local: undefined,
  },
];

describe('the callbacks of the array methods that hand them the elements of a Date-bearing array', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(ROWS)('$id', ({ tag, local }) => {
    const source = `export function Widget(){const tag=${tag};return <p>{${ONE}}</p>;}`;

    expect(firstLocalInput(api, source)).toBe(local);
  });
});

function firstLocalInput(api: API, source: string): string | undefined {
  using parsed = parseModule(api, 'render-element-callback-methods.tsx', source);
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
