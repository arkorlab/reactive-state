import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renderLocalInput } from '../src/compiler/render-local-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DATE_TEXT = 'writes a date as text of the time zone where it runs';

const REST = '(_s:TemplateStringsArray,...values:unknown[])=>';
const OPEN = '${';
const ONE = `tag\`${OPEN}new Date(0)}\``;
const KEEP = 'const keep=(_value:unknown,_index:number,all:unknown[])=>all;';

/**
 * What a function of the file answers when `map` or `flatMap` hands it the elements of a Date-bearing
 * array: it is handed the element, the index and the array itself, so a function that answers its
 * third parameter answers the array, which the tag writes as text. `Array.from` hands its mapper the
 * element and the index only, and a function that answers the index or the length answers none.
 */
const CASES = [
  {
    id: 'map-of-a-function-answering-the-array',
    pre: KEEP,
    tag: `${REST}values.map(keep).join('')`,
    local: DATE_TEXT,
  },
  {
    id: 'map-of-a-function-answering-the-array-written-with-String',
    pre: KEEP,
    tag: `${REST}String(values.map(keep))`,
    local: DATE_TEXT,
  },
  {
    id: 'flatMap-of-a-function-answering-the-array',
    pre: KEEP,
    tag: `${REST}values.flatMap(keep).join('')`,
    local: DATE_TEXT,
  },
  {
    id: 'map-of-a-function-answering-a-conditional-array',
    pre: 'const maybe=(_value:unknown,index:number,all:unknown[])=>(index>0?all:[]);',
    tag: `${REST}values.map(maybe).join('')`,
    local: DATE_TEXT,
  },
  {
    id: 'map-of-a-function-answering-the-element-pin',
    pre: 'const same=(value:unknown)=>value;',
    tag: `${REST}values.map(same).join('')`,
    local: DATE_TEXT,
  },
  {
    id: 'map-of-a-function-answering-the-length-pin',
    pre: 'const size=(_value:unknown,_index:number,all:unknown[])=>all.length;',
    tag: `${REST}values.map(size).join('')`,
    local: undefined,
  },
  {
    id: 'map-of-a-function-answering-the-index-pin',
    pre: 'const at=(_value:unknown,index:number)=>index;',
    tag: `${REST}values.map(at).join('')`,
    local: undefined,
  },
  {
    id: 'map-of-a-function-answering-the-array-from-another-receiver-pin',
    pre: KEEP,
    tag: `${REST}[1,2].map(keep).join('')`,
    local: undefined,
  },
  {
    id: 'Array-from-of-a-function-answering-the-third-parameter-pin',
    pre: KEEP,
    tag: `${REST}Array.from(values,keep).join('')`,
    local: undefined,
  },
  {
    id: 'Array-from-of-a-function-answering-the-element-pin',
    pre: 'const same=(value:unknown)=>value;',
    tag: `${REST}Array.from(values,same).join('')`,
    local: DATE_TEXT,
  },
] as const;

describe('what a function of the file answers when map hands it the array it maps', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ pre, tag, local }) => {
    const source = `${pre}export function Widget(){const tag=${tag};return <p>{${ONE}}</p>;}`;

    expect(firstLocalInput(api, source)).toBe(local);
  });
});

function firstLocalInput(api: API, source: string): string | undefined {
  using parsed = parseModule(api, 'render-mapped-callback-arrays.tsx', source);
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
