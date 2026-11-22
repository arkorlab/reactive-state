import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renderLocalInput } from '../src/compiler/render-local-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DATE_TEXT = 'writes a date as text of the time zone where it runs';

const REST = '(_s:TemplateStringsArray,...values:unknown[])=>';
const ONE = `tag\`\${new Date(0)}\``;
const TEXT_OF = '(value:unknown)=>String(value)';

/**
 * An array method a tag calls through `call`, `apply` or `Reflect.apply` (`Array.prototype.map.call(values,
 * fn)`, `values.map.call(values, fn)`) is the method of the receiver it is handed, with the arguments it
 * is handed: the callback it is given reads the elements, and what it answers is what the same call
 * written directly would answer. The methods are those of one list, as in a direct call.
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

interface Row {
  readonly id: string;
  readonly tag: string;
  readonly local: string | undefined;
}

const ROWS: readonly Row[] = [
  {
    id: 'map-called-on-the-method',
    tag: `${REST}values.map.call(values,${TEXT_OF}).join('')`,
    local: DATE_TEXT,
  },
  {
    id: 'map-called-directly-with-a-parenthesized-callback',
    tag: `${REST}values.map((${TEXT_OF})).join('')`,
    local: DATE_TEXT,
  },
  {
    id: 'map-applied-on-the-method',
    tag: `${REST}values.map.apply(values,[${TEXT_OF}]).join('')`,
    local: DATE_TEXT,
  },
  {
    id: 'map-of-Reflect-apply',
    tag: `${REST}Reflect.apply(values.map,values,[${TEXT_OF}]).join('')`,
    local: DATE_TEXT,
  },
  {
    id: 'map-borrowed-from-an-array-literal',
    tag: `${REST}[].map.call(values,${TEXT_OF}).join('')`,
    local: DATE_TEXT,
  },
  {
    id: 'map-borrowed-with-a-parenthesized-callback',
    tag: `${REST}Array.prototype.map.call(values,(${TEXT_OF})).join('')`,
    local: DATE_TEXT,
  },
  {
    id: 'map-borrowed-with-a-callback-that-reads-the-array',
    tag: `${REST}Array.prototype.map.call(values,(_value:unknown,_index:number,all:unknown[])=>all.join('')).join('')`,
    local: DATE_TEXT,
  },
  {
    id: 'map-borrowed-from-the-arguments-of-a-function-tag',
    tag: `function(_strings:TemplateStringsArray,_value:unknown){return Array.prototype.map.call(arguments,${TEXT_OF}).join('');}`,
    local: DATE_TEXT,
  },
  {
    id: 'reduce-borrowed',
    tag: `${REST}Array.prototype.reduce.call(values,(text:string,value:unknown)=>text+String(value),'')`,
    local: DATE_TEXT,
  },
  {
    id: 'reduceRight-borrowed',
    tag: `${REST}Array.prototype.reduceRight.call(values,(text:string,value:unknown)=>text+String(value),'')`,
    local: DATE_TEXT,
  },
  {
    id: 'reduce-borrowed-with-the-array-parameter',
    tag: `${REST}Array.prototype.reduce.call(values,(text:string,_value:unknown,_index:number,all:unknown[])=>text+all.join(''),'')`,
    local: DATE_TEXT,
  },
  {
    id: 'sort-borrowed-with-a-callback-that-writes-text',
    tag: `${REST}Array.prototype.sort.call(values,(a:unknown,b:unknown)=>(String(a)<String(b)?-1:1))`,
    local: DATE_TEXT,
  },
  ...ELEMENT_METHODS.map((method): Row => {
    return {
      id: `${method}-borrowed-from-the-prototype`,
      tag: `${REST}Array.prototype.${method}.call(values,${TEXT_OF})`,
      local: DATE_TEXT,
    };
  }),
  {
    id: 'map-borrowed-answers-its-elements',
    tag: `${REST}Array.prototype.map.call(values,(value:unknown)=>value).join('')`,
    local: DATE_TEXT,
  },
  {
    id: 'filter-borrowed-answers-its-elements',
    tag: `${REST}String(Array.prototype.filter.call(values,()=>true))`,
    local: DATE_TEXT,
  },
  {
    id: 'filter-called-on-the-method-answers-its-elements',
    tag: `${REST}values.filter.call(values,()=>true).join('')`,
    local: DATE_TEXT,
  },
  {
    id: 'find-borrowed-answers-an-element',
    tag: `${REST}String(Array.prototype.find.call(values,()=>true))`,
    local: DATE_TEXT,
  },
  {
    id: 'slice-of-Reflect-apply-answers-its-elements',
    tag: `${REST}String(Reflect.apply(Array.prototype.slice,values,[0]))`,
    local: DATE_TEXT,
  },
  {
    id: 'slice-applied-answers-its-elements',
    tag: `${REST}String(Array.prototype.slice.apply(values,[0]))`,
    local: DATE_TEXT,
  },
  {
    id: 'slice-called-was-followed-pin',
    tag: `${REST}String(Array.prototype.slice.call(values,0))`,
    local: DATE_TEXT,
  },
  {
    id: 'slice-called-past-the-substitutions-pin',
    tag: `${REST}String(Array.prototype.slice.call(values,1))`,
    local: undefined,
  },
  {
    id: 'map-borrowed-reads-the-time-pin',
    tag: `${REST}Array.prototype.map.call(values,(value:unknown)=>(value as Date).getTime()).join('')`,
    local: undefined,
  },
  {
    id: 'map-called-on-the-method-reads-the-time-pin',
    tag: `${REST}values.map.call(values,(value:unknown)=>(value as Date).getTime()).join('')`,
    local: undefined,
  },
  {
    id: 'map-applied-reads-the-time-pin',
    tag: `${REST}values.map.apply(values,[(value:unknown)=>(value as Date).getTime()]).join('')`,
    local: undefined,
  },
  {
    id: 'reduce-borrowed-reads-the-time-pin',
    tag: `${REST}Array.prototype.reduce.call(values,(total:number,value:unknown)=>total+(value as Date).getTime(),0)`,
    local: undefined,
  },
  {
    id: 'sort-borrowed-reads-the-time-pin',
    tag: `${REST}Array.prototype.sort.call(values,(a:Date,b:Date)=>a.getTime()-b.getTime())`,
    local: undefined,
  },
  {
    id: 'map-borrowed-from-an-array-without-dates-pin',
    tag: `${REST}Array.prototype.map.call([1,2],(value:number)=>String(value)).join('')`,
    local: undefined,
  },
  {
    id: 'map-borrowed-from-a-text-pin',
    tag: `${REST}Array.prototype.map.call('abc',(letter:string)=>String(letter)).join('')`,
    local: undefined,
  },
  {
    id: 'map-borrowed-answers-the-times-pin',
    tag: `${REST}String(Array.prototype.map.call(values,(value:unknown)=>(value as Date).getTime()))`,
    local: undefined,
  },
  {
    id: 'indexOf-borrowed-answers-a-position-pin',
    tag: `${REST}String(Array.prototype.indexOf.call(values,1))`,
    local: undefined,
  },
  {
    id: 'function-called-with-a-callback-is-no-array-method-pin',
    tag: `${REST}{const run=(callback:(each:unknown)=>string)=>callback(1);return run.call(null,(each:unknown)=>String(each));}`,
    local: undefined,
  },
];

describe('array methods a tag calls through call, apply or Reflect.apply', () => {
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
  using parsed = parseModule(api, 'render-indirect-array-calls.tsx', source);
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
