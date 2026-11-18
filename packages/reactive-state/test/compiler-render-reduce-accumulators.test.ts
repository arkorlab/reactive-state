import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renderLocalInput } from '../src/compiler/render-local-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DATE_TEXT = 'writes a date as text of the time zone where it runs';

const REST = '(_s:TemplateStringsArray,...values:unknown[])=>';
const REST_DATES = '(_s:TemplateStringsArray,...values:Date[])=>';
const ONE = `tag\`\${new Date(0)}\``;

/**
 * A tag that reduces its substitutions into an array it is given as the accumulator, and writes the
 * array as text: what the callback puts into the accumulator (`push`, `unshift`, `splice`, `fill`,
 * an index assignment) is kept by the array it answers. What it puts in as a call's result, a count
 * or a string of its own makes the accumulator carry nothing.
 */
const CASES = [
  {
    id: 'push-then-return-the-accumulator',
    tag: `${REST}String(values.reduce((out:unknown[],value)=>{out.push(value);return out;},[]))`,
    local: DATE_TEXT,
  },
  {
    id: 'push-then-join',
    tag: `${REST}values.reduce((out:unknown[],value)=>{out.push(value);return out;},[]).join('')`,
    local: DATE_TEXT,
  },
  {
    id: 'push-in-a-comma-expression',
    tag: `${REST}String(values.reduce((out:unknown[],value)=>(out.push(value),out),[]))`,
    local: DATE_TEXT,
  },
  {
    id: 'unshift',
    tag: `${REST}String(values.reduce((out:unknown[],value)=>{out.unshift(value);return out;},[]))`,
    local: DATE_TEXT,
  },
  {
    id: 'splice-inserting',
    tag: `${REST}String(values.reduce((out:unknown[],value)=>{out.splice(0,0,value);return out;},[]))`,
    local: DATE_TEXT,
  },
  {
    id: 'index-assignment',
    tag: `${REST}String(values.reduce((out:unknown[],value,index)=>{out[index]=value;return out;},[]))`,
    local: DATE_TEXT,
  },
  {
    id: 'push-in-a-reduceRight',
    tag: `${REST}String(values.reduceRight((out:unknown[],value)=>{out.push(value);return out;},[]))`,
    local: DATE_TEXT,
  },
  {
    id: 'push-in-a-function-expression-callback',
    tag: `${REST}String(values.reduce(function(out:unknown[],value){out.push(value);return out;},[]))`,
    local: DATE_TEXT,
  },
  {
    id: 'push-of-the-element-inside-a-condition',
    tag: `${REST}String(values.reduce((out:unknown[],value)=>{if(value!==undefined){out.push(value);}return out;},[]))`,
    local: DATE_TEXT,
  },
  {
    id: 'concat-was-refused-pin',
    tag: `${REST}String(values.reduce((out:unknown[],value)=>out.concat(value),[]))`,
    local: DATE_TEXT,
  },
  {
    id: 'spread-was-refused-pin',
    tag: `${REST}String(values.reduce((out:unknown[],value)=>[...out,value],[]))`,
    local: DATE_TEXT,
  },
  {
    id: 'push-of-iso-text-pin',
    tag: `${REST_DATES}String(values.reduce((out:string[],value)=>{out.push(value.toISOString());return out;},[]))`,
    local: undefined,
  },
  {
    id: 'push-of-getTime-pin',
    tag: `${REST_DATES}String(values.reduce((out:number[],value)=>{out.push(value.getTime());return out;},[]))`,
    local: undefined,
  },
  {
    id: 'push-of-a-string-of-the-tags-own-pin',
    tag: `${REST}String(values.reduce((out:string[])=>{out.push('x');return out;},[]))`,
    local: undefined,
  },
  {
    id: 'push-into-another-array-pin',
    tag: `${REST}{const other:string[]=[];return String(values.reduce((out:number[])=>{other.push('x');return out;},[]));}`,
    local: undefined,
  },
  {
    id: 'index-assignment-of-iso-text-pin',
    tag: `${REST_DATES}String(values.reduce((out:string[],value,index)=>{out[index]=value.toISOString();return out;},[]))`,
    local: undefined,
  },
  {
    id: 'counting-pin',
    tag: `${REST}String(values.reduce((count:number)=>count+1,0))`,
    local: undefined,
  },
  {
    id: 'text-from-iso-pin',
    tag: `${REST_DATES}String(values.reduce((text:string,value)=>text+value.toISOString(),''))`,
    local: undefined,
  },
] as const;

describe('a reduction into an accumulator array a tag writes as text', () => {
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

  it('push-of-a-substitution-that-is-not-a-date-pin', () => {
    const source = `export function Widget(){const tag=${REST}String(values.reduce((out:unknown[],value)=>{out.push(value);return out;},[]));return <p>{tag\`\${'x'}\`}</p>;}`;

    expect(firstLocalInput(api, source)).toBeUndefined();
  });
});

function firstLocalInput(api: API, source: string): string | undefined {
  using parsed = parseModule(api, 'render-reduce-accumulators.tsx', source);
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
