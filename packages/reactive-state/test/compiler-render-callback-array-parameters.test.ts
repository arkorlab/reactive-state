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
 * A custom tag whose array callback reads the array it was called on. The third parameter of the
 * callbacks of `map`, `filter`, `forEach`, `every`, `some`, `find`, `findLast` and `flatMap`, and the
 * fourth of `reduce` and `reduceRight`, is the receiver itself, so it holds what the receiver holds.
 * The index in between is a number, and `Array.from` and `sort` pass no array.
 */
const CASES = [
  {
    id: 'map-joins-the-array',
    tag: `${REST}values.map((_value,_index,all)=>all.join('')).join('')`,
    local: DATE_TEXT,
  },
  {
    id: 'map-writes-the-array-as-text',
    tag: `${REST}values.map((_value,_index,all)=>String(all)).length+''`,
    local: DATE_TEXT,
  },
  {
    id: 'map-writes-the-array-in-a-template',
    tag: `${REST}values.map((_value,_index,all)=>\`\${all}\`).length+''`,
    local: DATE_TEXT,
  },
  {
    id: 'map-writes-the-next-element',
    tag: `${REST}values.map((_value,index,all)=>String(all[index+1])).length+''`,
    local: DATE_TEXT,
  },
  {
    id: 'forEach',
    tag: `${REST}{values.forEach((_value,_index,all)=>{String(all);});return '';}`,
    local: DATE_TEXT,
  },
  {
    id: 'filter',
    tag: `${REST}values.filter((_value,_index,all)=>String(all)==='').length+''`,
    local: DATE_TEXT,
  },
  {
    id: 'some',
    tag: `${REST}String(values.some((_value,_index,all)=>all.join('')==='x'))`,
    local: DATE_TEXT,
  },
  {
    id: 'every',
    tag: `${REST}String(values.every((_value,_index,all)=>all.join('')==='x'))`,
    local: DATE_TEXT,
  },
  {
    id: 'find',
    tag: `${REST}String(values.find((_value,_index,all)=>all.join('')==='x')===undefined)`,
    local: DATE_TEXT,
  },
  {
    id: 'flatMap',
    tag: `${REST}values.flatMap((_value,_index,all)=>[all.join('')]).length+''`,
    local: DATE_TEXT,
  },
  {
    id: 'reduce-joins-the-array',
    tag: `${REST}values.reduce((text,_value,_index,all)=>text+all.join(''),'')`,
    local: DATE_TEXT,
  },
  {
    id: 'reduceRight-joins-the-array',
    tag: `${REST}values.reduceRight((text,_value,_index,all)=>text+all.join(''),'')`,
    local: DATE_TEXT,
  },
  {
    id: 'reduce-without-an-initial-value',
    tag: `${REST}values.reduce((_total,_value,_index,all)=>all.join('')).length+''`,
    local: DATE_TEXT,
  },
  {
    id: 'map-of-a-named-callback',
    tag: `${REST}{const joined=(_value:unknown,_index:number,all:unknown[])=>all.join('');return values.map(joined).length+'';}`,
    local: DATE_TEXT,
  },
  {
    id: 'reduce-of-a-named-callback',
    tag: `${REST}{const joined=(text:string,_value:unknown,_index:number,all:unknown[])=>text+all.join('');return values.reduce(joined,'');}`,
    local: DATE_TEXT,
  },
  {
    id: 'map-of-a-copy',
    tag: `${REST}[...values].map((_value,_index,all)=>all.join('')).length+''`,
    local: DATE_TEXT,
  },
  {
    id: 'map-reads-the-length-pin',
    tag: `${REST}values.map((_value,index,all)=>String(all.length-index)).join(',')`,
    local: undefined,
  },
  {
    id: 'map-reads-the-index-of-the-value-pin',
    tag: `${REST}values.map((value,_index,all)=>String(all.indexOf(value))).join(',')`,
    local: undefined,
  },
  {
    id: 'map-reads-the-next-time-pin',
    tag: `${REST}values.map((_value,index,all)=>String((all[index+1] as Date|undefined)?.getTime())).join(',')`,
    local: undefined,
  },
  {
    id: 'reduce-counts-with-the-array-pin',
    tag: `${REST}String(values.reduce((total,_value,_index,all)=>total+all.length,0))`,
    local: undefined,
  },
  {
    id: 'map-writes-the-index-pin',
    tag: `${REST}values.map((_value,index)=>String(index)).join(',')`,
    local: undefined,
  },
  {
    id: 'map-writes-the-index-with-an-unused-array-pin',
    tag: `${REST}values.map((_value,index,_all)=>String(index)).join(',')`,
    local: undefined,
  },
  {
    id: 'reduce-writes-the-index-pin',
    tag: `${REST}values.reduce((text,_value,index,_all)=>text+index,'')`,
    local: undefined,
  },
  {
    id: 'Array-from-passes-no-array-pin',
    tag: `${REST}Array.from(values,(_value,_index,all)=>String(all)).length+''`,
    local: undefined,
  },
  {
    id: 'sort-passes-no-array-pin',
    tag: `${REST}[...values].sort((_first,_second,all)=>String(all)==='x'?1:0).length+''`,
    local: undefined,
  },
  {
    id: 'map-of-times-then-array-pin',
    tag: `${REST}values.map((value)=>(value as Date).getTime()).map((_time,_index,all)=>all.join('')).join('')`,
    local: undefined,
  },
] as const;

describe('the array an array callback is handed as its last parameter', () => {
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

  it('map-of-a-substitution-that-is-not-a-date-pin', () => {
    const source = `export function Widget(){const tag=${REST}values.map((_value,_index,all)=>all.join('')).join('');return <p>{tag\`\${'x'}\`}</p>;}`;

    expect(firstLocalInput(api, source)).toBeUndefined();
  });
});

function firstLocalInput(api: API, source: string): string | undefined {
  using parsed = parseModule(api, 'render-callback-array-parameters.tsx', source);
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
