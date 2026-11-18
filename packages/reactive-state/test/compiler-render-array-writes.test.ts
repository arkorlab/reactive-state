import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renderLocalInput } from '../src/compiler/render-local-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DATE_TEXT = 'writes a date as text of the time zone where it runs';

const REST = '(strings:TemplateStringsArray,...values:unknown[])=>';
const DATED = '(_s:TemplateStringsArray,date:Date)=>';
const ONE = `tag\`a\${new Date(0)}b\``;

/**
 * A custom tag that puts a substitution into an array and writes the array as text: what is put
 * into an array, by a call (`push`, `unshift`, `splice`, `fill`) or an index assignment, is carried
 * by the array, and `with`, `toSpliced` and `fill` answer an array that holds their argument. What
 * is put in as a call's result, a number or a string of the tag's own makes the array carry nothing.
 */
const CASES = [
  {
    id: 'push-loop-then-join',
    tag: `${REST}{const out:unknown[]=[];for(let i=0;i<strings.length;i++){out.push(strings[i]);if(i<values.length)out.push(values[i]);}return out.join('');}`,
    local: DATE_TEXT,
  },
  {
    id: 'push-in-a-forEach-callback-then-join',
    tag: `${REST}{const out:unknown[]=[];values.forEach((value)=>{out.push(value);});return out.join('');}`,
    local: DATE_TEXT,
  },
  {
    id: 'push-in-a-for-of-loop-then-join',
    tag: `${REST}{const out:unknown[]=[];for(const value of values){out.push(value);}return out.join('');}`,
    local: DATE_TEXT,
  },
  {
    id: 'push-then-String',
    tag: `${DATED}{const out:unknown[]=[];out.push(date);return String(out);}`,
    local: DATE_TEXT,
  },
  {
    id: 'push-then-join',
    tag: `${DATED}{const out:unknown[]=[];out.push(date);return out.join('');}`,
    local: DATE_TEXT,
  },
  {
    id: 'push-then-written-in-a-template',
    tag: `${DATED}{const out:unknown[]=[];out.push(date);return \`at:\${out}\`;}`,
    local: DATE_TEXT,
  },
  {
    id: 'push-of-a-spread-of-the-substitutions',
    tag: `${REST}{const out:unknown[]=[];out.push(...values);return out.join(',');}`,
    local: DATE_TEXT,
  },
  {
    id: 'unshift-then-join',
    tag: `${DATED}{const out:unknown[]=[];out.unshift(date);return out.join('');}`,
    local: DATE_TEXT,
  },
  {
    id: 'splice-inserting-then-join',
    tag: `${DATED}{const out:unknown[]=[];out.splice(0,0,date);return out.join('');}`,
    local: DATE_TEXT,
  },
  {
    id: 'index-assignment-then-join',
    tag: `${DATED}{const out:unknown[]=[];out[0]=date;return out.join('');}`,
    local: DATE_TEXT,
  },
  {
    id: 'fill-of-a-variable-then-String',
    tag: `${DATED}{const out:unknown[]=[0];out.fill(date);return String(out);}`,
    local: DATE_TEXT,
  },
  {
    id: 'push-into-an-array-that-starts-full',
    tag: `${DATED}{const out:unknown[]=['a'];out.push(date);return out.join('');}`,
    local: DATE_TEXT,
  },
  {
    id: 'push-kept-in-a-let-that-is-reassigned',
    tag: `${DATED}{let out:unknown[]=[];out=[];out.push(date);return out.join('');}`,
    local: DATE_TEXT,
  },
  {
    id: 'native-object-mutator-of-the-array-is-refused-coarsely',
    tag: `${DATED}{const out:unknown[]=[];Object.defineProperty(out,'0',{value:date});return out.join('');}`,
    local: DATE_TEXT,
  },
  { id: 'fill-argument', tag: `${DATED}String([0].fill(date as never))`, local: DATE_TEXT },
  { id: 'with-argument', tag: `${DATED}String([0].with(0,date as never))`, local: DATE_TEXT },
  {
    id: 'toSpliced-argument',
    tag: `${DATED}String([0].toSpliced(0,0,date as never))`,
    local: DATE_TEXT,
  },
  { id: 'array-literal-was-followed-pin', tag: `${DATED}String([0,date])`, local: DATE_TEXT },
  {
    id: 'concat-argument-was-followed-pin',
    tag: `${DATED}String([0].concat(date as never))`,
    local: DATE_TEXT,
  },
  {
    id: 'push-of-iso-text-pin',
    tag: `${DATED}{const out:string[]=[];out.push(date.toISOString());return out.join('');}`,
    local: undefined,
  },
  {
    id: 'push-loop-of-iso-text-pin',
    tag: `(strings:TemplateStringsArray,...values:Date[])=>{const out:string[]=[];for(let i=0;i<strings.length;i++){out.push(strings[i]!);if(i<values.length)out.push(values[i]!.toISOString());}return out.join('');}`,
    local: undefined,
  },
  {
    id: 'push-of-getTime-pin',
    tag: `${DATED}{const out:number[]=[];out.push(date.getTime());return out.join(',');}`,
    local: undefined,
  },
  {
    id: 'push-of-the-strings-only-pin',
    tag: `${REST}{const out:string[]=[];for(const part of strings)out.push(part);return out.join('');}`,
    local: undefined,
  },
  {
    id: 'push-of-a-count-pin',
    tag: `${REST}{const out:number[]=[];out.push(values.length);return out.join(',');}`,
    local: undefined,
  },
  {
    id: 'push-of-iso-text-in-a-forEach-callback-pin',
    tag: `(_s:TemplateStringsArray,...values:Date[])=>{const out:string[]=[];values.forEach((value)=>{out.push(value.toISOString());});return out.join('');}`,
    local: undefined,
  },
  {
    id: 'array-handed-to-a-helper-then-joined-pin',
    tag: `${DATED}{const out:unknown[]=['x'];out.push(date.toISOString());return ((list:unknown[])=>list)(out).join('');}`,
    local: undefined,
  },
  {
    id: 'array-returned-not-written-pin',
    tag: `${DATED}{const out:unknown[]=[];out.push(date);return out;}`,
    local: undefined,
  },
  {
    id: 'includes-of-the-date-pin',
    tag: `${DATED}String([0].includes(date as never))`,
    local: undefined,
  },
  {
    id: 'indexOf-the-date-pin',
    tag: `${DATED}String([0].indexOf(date as never))`,
    local: undefined,
  },
  {
    id: 'fill-with-text-pin',
    tag: `${DATED}String([0].fill('x' as never))`,
    local: undefined,
  },
  {
    id: 'with-text-pin',
    tag: `${DATED}String([0].with(0,'x' as never))`,
    local: undefined,
  },
] as const;

describe('an array a tag puts a substitution into', () => {
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
    const source = `export function Widget(){const tag=${REST}{const out:unknown[]=[];out.push(...values);return out.join(',');};return <p>{tag\`\${'x'}\`}</p>;}`;

    expect(firstLocalInput(api, source)).toBeUndefined();
  });
});

function firstLocalInput(api: API, source: string): string | undefined {
  using parsed = parseModule(api, 'render-array-writes.tsx', source);
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
