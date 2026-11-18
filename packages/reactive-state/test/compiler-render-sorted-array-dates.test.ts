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
const BY_TEXT = 'const byText=(a:unknown,b:unknown)=>(String(a)<String(b)?-1:1);';
const BY_TIME = 'const byTime=(a:Date,b:Date)=>a.getTime()-b.getTime();';

/**
 * A custom tag that sorts its Date substitutions. `sort` and `toSorted` with no comparator compare
 * the string each element converts to, which for a Date is the text of the time zone where it
 * runs; with a comparator they hand it the elements themselves, so a comparator that reads their
 * time reads no zone and one that writes them as text does.
 */
const CASES = [
  {
    id: 'sort-without-a-comparator',
    tag: `${REST_DATES}values.sort().map((value)=>value.getTime()).join(',')`,
    local: DATE_TEXT,
  },
  {
    id: 'toSorted-without-a-comparator',
    tag: `${REST_DATES}values.toSorted().map((value)=>value.getTime()).join(',')`,
    local: DATE_TEXT,
  },
  {
    id: 'sort-of-unknown-values',
    tag: `${REST}{values.sort();return 'fixed';}`,
    local: DATE_TEXT,
  },
  {
    id: 'sort-with-an-undefined-comparator',
    tag: `${REST_DATES}values.sort(undefined).map((value)=>value.getTime()).join(',')`,
    local: DATE_TEXT,
  },
  {
    id: 'sort-of-a-copy',
    tag: `${REST_DATES}[...values].sort().map((value)=>value.getTime()).join(',')`,
    local: DATE_TEXT,
  },
  {
    id: 'sort-of-a-slice',
    tag: `${REST_DATES}values.slice(0).sort().map((value)=>value.getTime()).join(',')`,
    local: DATE_TEXT,
  },
  {
    id: 'sort-of-a-filter',
    tag: `${REST_DATES}values.filter(Boolean).toSorted().map((value)=>value.getTime()).join(',')`,
    local: DATE_TEXT,
  },
  {
    id: 'sort-of-a-kept-array',
    tag: `${REST_DATES}{const sorted=values.sort();return sorted.length+'';}`,
    local: DATE_TEXT,
  },
  {
    id: 'sort-of-an-array-literal',
    tag: '(_s:TemplateStringsArray,date:Date)=>[date,date].sort().length+""',
    local: DATE_TEXT,
  },
  {
    id: 'sort-borrowed-from-the-prototype',
    tag: `${REST_DATES}Array.prototype.sort.call(values).length+''`,
    local: DATE_TEXT,
  },
  {
    id: 'toSorted-borrowed-from-the-prototype',
    tag: `${REST_DATES}Array.prototype.toSorted.call(values).length+''`,
    local: DATE_TEXT,
  },
  {
    id: 'sort-with-a-comparator-that-writes-text',
    tag: `${REST_DATES}values.sort((a,b)=>(String(a)<String(b)?-1:1)).length+''`,
    local: DATE_TEXT,
  },
  {
    id: 'toSorted-with-a-comparator-that-writes-text-in-a-template',
    tag: `${REST_DATES}values.toSorted((a,b)=>\`\${a}\`<\`\${b}\`?-1:1).length+''`,
    local: DATE_TEXT,
  },
  {
    id: 'sort-with-a-comparator-that-reads-the-second-as-text',
    tag: `${REST_DATES}values.sort((a,b)=>a.getTime()-Number(String(b))).length+''`,
    local: DATE_TEXT,
  },
  {
    id: 'sort-with-a-file-local-comparator-that-writes-text',
    tag: `${REST_DATES}{${BY_TEXT}return values.sort(byText).length+'';}`,
    local: DATE_TEXT,
  },
  {
    id: 'sort-with-an-imported-comparator',
    tag: `${REST_DATES}values.sort(importedComparator).length+''`,
    local: DATE_TEXT,
  },
  {
    id: 'sort-with-a-spread-comparator',
    tag: `${REST_DATES}values.sort(...([] as never[])).length+''`,
    local: DATE_TEXT,
  },
  {
    id: 'sort-with-a-comparator-that-reads-time-pin',
    tag: `${REST_DATES}values.sort((a,b)=>a.getTime()-b.getTime()).length+''`,
    local: undefined,
  },
  {
    id: 'sort-with-a-comparator-that-subtracts-pin',
    tag: `${REST_DATES}values.sort((a,b)=>Number(a)-Number(b)).length+''`,
    local: undefined,
  },
  {
    id: 'sort-with-a-comparator-that-compares-pin',
    tag: `${REST_DATES}values.sort((a,b)=>(a>b?1:-1)).length+''`,
    local: undefined,
  },
  {
    id: 'toSorted-with-a-comparator-that-reads-time-pin',
    tag: `${REST_DATES}values.toSorted((a,b)=>a.valueOf()-b.valueOf()).length+''`,
    local: undefined,
  },
  {
    id: 'sort-with-a-file-local-comparator-that-reads-time-pin',
    tag: `${REST_DATES}{${BY_TIME}return values.sort(byTime).length+'';}`,
    local: undefined,
  },
  {
    id: 'sort-of-times-pin',
    tag: `${REST_DATES}values.map((value)=>value.getTime()).sort().join(',')`,
    local: undefined,
  },
  {
    id: 'sort-of-iso-text-pin',
    tag: `${REST_DATES}values.map((value)=>value.toISOString()).sort().join(',')`,
    local: undefined,
  },
  {
    id: 'sort-of-a-local-array-without-dates-pin',
    tag: `${REST}{const names=['b','a'];return names.sort().join(',');}`,
    local: undefined,
  },
] as const;

describe('sorting the Date substitutions of a tag', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ tag, local }) => {
    const source = `import { importedComparator } from './comparator';export function Widget(){const tag=${tag};return <p>{${ONE}}</p>;}`;

    expect(firstLocalInput(api, source)).toBe(local);
  });

  it('sort-of-a-substitution-that-is-not-a-date-pin', () => {
    const source = `export function Widget(){const tag=${REST}values.sort().join(',');return <p>{tag\`\${'b'}\${'a'}\`}</p>;}`;

    expect(firstLocalInput(api, source)).toBeUndefined();
  });
});

function firstLocalInput(api: API, source: string): string | undefined {
  using parsed = parseModule(api, 'render-sorted-array-dates.tsx', source);
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
