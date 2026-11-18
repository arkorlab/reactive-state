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
 * A custom tag that selects a substitution with an array method and then writes it as text: the
 * method returns what it selects or collects from its receiver, so it carries a Date as the
 * receiver does. `reduce` returns the callback's result, or the one element when no initial value
 * is given. Methods that answer a position, a flag or a count carry nothing.
 */
const CASES = [
  { id: 'find', tag: `${REST}String(values.find(()=>true))`, local: DATE_TEXT },
  { id: 'findLast', tag: `${REST}String(values.findLast(()=>true))`, local: DATE_TEXT },
  {
    id: 'find-by-instanceof',
    tag: `${REST}String(values.find((value)=>value instanceof Date))`,
    local: DATE_TEXT,
  },
  {
    id: 'find-kept-then-written-in-a-template',
    tag: `${REST}{const when=values.find((value)=>value instanceof Date);return \`at:\${when}\`;}`,
    local: DATE_TEXT,
  },
  {
    id: 'find-written-in-a-template',
    tag: `${REST}\`\${values.find(()=>true)}\``,
    local: DATE_TEXT,
  },
  { id: 'find-added-to-text', tag: `${REST}'at:'+values.find(()=>true)`, local: DATE_TEXT },
  {
    id: 'find-of-a-copy',
    tag: `${REST}{const copy=[...values];return String(copy.find(()=>true));}`,
    local: DATE_TEXT,
  },
  {
    id: 'find-of-an-array-literal',
    tag: '(_s:TemplateStringsArray,date:Date)=>String([date].find(()=>true))',
    local: DATE_TEXT,
  },
  {
    id: 'find-in-an-array-pattern',
    tag: `${REST}{const [first]=[values.find(()=>true)];return String(first);}`,
    local: DATE_TEXT,
  },
  { id: 'pop', tag: `${REST}String(values.pop())`, local: DATE_TEXT },
  { id: 'shift', tag: `${REST}String(values.shift())`, local: DATE_TEXT },
  { id: 'splice', tag: `${REST}String(values.splice(0,1))`, local: DATE_TEXT },
  { id: 'toSpliced', tag: `${REST}String(values.toSpliced(1))`, local: DATE_TEXT },
  { id: 'with', tag: `${REST}String(values.with(0,values[0]))`, local: DATE_TEXT },
  { id: 'fill', tag: `${REST}String(values.fill(values[0]))`, local: DATE_TEXT },
  { id: 'copyWithin', tag: `${REST}String(values.copyWithin(0,0))`, local: DATE_TEXT },
  {
    id: 'reduce-without-initial-value',
    tag: `${REST}String(values.reduce(()=>'fixed'))`,
    local: DATE_TEXT,
  },
  {
    id: 'reduce-returning-the-element',
    tag: `${REST}String(values.reduce((_total,value)=>value,null))`,
    local: DATE_TEXT,
  },
  {
    id: 'reduceRight-without-initial-value',
    tag: `${REST}String(values.reduceRight(()=>'fixed'))`,
    local: DATE_TEXT,
  },
  {
    id: 'reduce-from-a-date-initial-value',
    tag: '(_s:TemplateStringsArray,date:Date)=>String([1].reduce((total)=>total,date))',
    local: DATE_TEXT,
  },
  {
    id: 'reduce-with-a-callback-the-walk-cannot-read',
    tag: `${REST}String(values.reduce(Math.max as never,null))`,
    local: DATE_TEXT,
  },
  {
    id: 'filter-was-followed-pin',
    tag: `${REST}String(values.filter(()=>true))`,
    local: DATE_TEXT,
  },
  { id: 'at-was-followed-pin', tag: `${REST}String(values.at(0))`, local: DATE_TEXT },
  { id: 'slice-was-followed-pin', tag: `${REST}String(values.slice(0))`, local: DATE_TEXT },
  {
    id: 'reduce-building-text-from-iso-in-a-template-pin',
    tag: `${REST_DATES}{const text=values.reduce((total,value)=>total+value.toISOString(),'');return \`\${text}\`;}`,
    local: undefined,
  },
  {
    id: 'reduce-building-text-from-iso-in-String-pin',
    tag: `${REST_DATES}String(values.reduce((total,value)=>total+value.toISOString(),''))`,
    local: undefined,
  },
  {
    id: 'reduce-counting-pin',
    tag: `${REST}String(values.reduce((total)=>total+1,0))`,
    local: undefined,
  },
  {
    id: 'find-then-getTime-pin',
    tag: `${REST_DATES}String(values.find(()=>true)!.getTime())`,
    local: undefined,
  },
  {
    id: 'find-then-toISOString-pin',
    tag: `${REST_DATES}\`\${values.find(()=>true)!.toISOString()}\``,
    local: undefined,
  },
  { id: 'indexOf-pin', tag: `${REST}String(values.indexOf(null))`, local: undefined },
  { id: 'includes-pin', tag: `${REST}String(values.includes(null))`, local: undefined },
  { id: 'findIndex-pin', tag: `${REST}String(values.findIndex(()=>true))`, local: undefined },
  {
    id: 'findLastIndex-pin',
    tag: `${REST}String(values.findLastIndex(()=>true))`,
    local: undefined,
  },
  { id: 'some-pin', tag: `${REST}String(values.some(()=>true))`, local: undefined },
  { id: 'every-pin', tag: `${REST}String(values.every(()=>true))`, local: undefined },
  { id: 'length-pin', tag: `${REST}String(values.length)`, local: undefined },
] as const;

describe('array methods that select a substitution a tag then writes as text', () => {
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

  it('find-of-a-substitution-that-is-not-a-date-pin', () => {
    const source = `export function Widget(){const tag=${REST}String(values.find(()=>true));return <p>{tag\`\${'x'}\`}</p>;}`;

    expect(firstLocalInput(api, source)).toBeUndefined();
  });
});

function firstLocalInput(api: API, source: string): string | undefined {
  using parsed = parseModule(api, 'render-array-element-methods.tsx', source);
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
