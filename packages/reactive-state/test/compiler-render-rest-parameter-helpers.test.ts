import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renderLocalInput } from '../src/compiler/render-local-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DATE_TEXT = 'writes a date as text of the time zone where it runs';

const DATED = '(_s:TemplateStringsArray,date:Date)=>';
const REST = '(_s:TemplateStringsArray,...values:unknown[])=>';
const OPEN = '${';
const ONE = `tag\`${OPEN}new Date(0)}\``;

/**
 * A helper of the file that returns what it makes of a list it is handed (`(...items) => items[0]`,
 * `([head]) => head`, `(...items) => items.find(...)`) answers the Date the call hands it, which the
 * tag then writes as text. The walk does not tell the positions of a list apart, so a rest
 * parameter that is handed a Date, and the names of an array pattern, are the Date: a helper that
 * selects another position than the Date's is refused too. What it makes of the list (its length,
 * a flag), and of a member of an object, answers none.
 */
const CASES = [
  {
    id: 'rest-parameter-answers-its-first',
    pre: 'const head=(...items:unknown[])=>items[0];',
    tag: `${DATED}String(head(date))`,
    local: DATE_TEXT,
  },
  {
    id: 'rest-parameter-answers-an-element-it-finds',
    pre: 'const coalesce=(...items:unknown[])=>items.find((item)=>item!=null);',
    tag: `${DATED}String(coalesce(date,'x'))`,
    local: DATE_TEXT,
  },
  {
    id: 'rest-parameter-answers-its-last',
    pre: 'const last=(...items:unknown[])=>items.at(-1);',
    tag: `${DATED}String(last('x',date))`,
    local: DATE_TEXT,
  },
  {
    id: 'rest-parameter-after-a-plain-one',
    pre: 'const tail=(_separator:string,...parts:unknown[])=>parts[0];',
    tag: `${DATED}String(tail('-',date))`,
    local: DATE_TEXT,
  },
  {
    id: 'rest-parameter-given-a-spread-of-the-substitutions',
    pre: 'const head=(...items:unknown[])=>items[0];',
    tag: `${REST}String(head(...values))`,
    local: DATE_TEXT,
  },
  {
    id: 'rest-parameter-given-the-date-after-a-spread',
    pre: 'const head=(...items:unknown[])=>items[0];',
    tag: `${DATED}String(head(...[1,2],date))`,
    local: DATE_TEXT,
  },
  {
    id: 'rest-parameter-selecting-another-element-is-refused-pin',
    pre: 'const pick=(...items:unknown[])=>items[1];',
    tag: `${DATED}String(pick(date,'ok'))`,
    local: DATE_TEXT,
  },
  {
    id: 'rest-parameter-returned-whole-and-written-as-text',
    pre: 'const all=(...items:unknown[])=>items;',
    tag: `${DATED}String(all(date))`,
    local: DATE_TEXT,
  },
  {
    id: 'array-pattern-answers-its-first',
    pre: 'const first=([head]:unknown[])=>head;',
    tag: `${DATED}String(first([date]))`,
    local: DATE_TEXT,
  },
  {
    id: 'array-pattern-answers-the-rest-of-a-list',
    pre: 'const rest=([_head,...tail]:unknown[])=>tail;',
    tag: `${DATED}String(rest([1,date]))`,
    local: DATE_TEXT,
  },
  {
    id: 'array-pattern-after-a-plain-parameter',
    pre: 'const second=(_first:unknown,[head]:unknown[])=>head;',
    tag: `${DATED}String(second(1,[date]))`,
    local: DATE_TEXT,
  },
  {
    id: 'rest-parameter-answering-its-length-pin',
    pre: 'const count=(...items:unknown[])=>items.length;',
    tag: `${DATED}String(count(date))`,
    local: undefined,
  },
  {
    id: 'rest-parameter-answering-a-flag-pin',
    pre: 'const some=(...items:unknown[])=>items.some(Boolean);',
    tag: `${DATED}String(some(date))`,
    local: undefined,
  },
  {
    id: 'rest-parameter-answering-the-time-of-its-first-pin',
    pre: 'const time=(...items:Date[])=>items[0]!.getTime();',
    tag: `${DATED}String(time(date))`,
    local: undefined,
  },
  {
    id: 'rest-parameter-handed-no-date-pin',
    pre: 'const head=(...items:unknown[])=>items[0];',
    tag: `${DATED}String(head('x',date.getTime()))`,
    local: undefined,
  },
  {
    id: 'array-pattern-answering-a-constant-pin',
    pre: 'const none=([_head]:unknown[])=>1;',
    tag: `${DATED}String(none([date]))`,
    local: undefined,
  },
  {
    id: 'object-pattern-member-pin',
    pre: 'const label=({length}:{length:number})=>length;',
    tag: `${DATED}String(label(date as never))`,
    local: undefined,
  },
] as const;

describe('a helper of the file that answers what it makes of a list it is handed', () => {
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
  using parsed = parseModule(api, 'render-rest-parameter-helpers.tsx', source);
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
