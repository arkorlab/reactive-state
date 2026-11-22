import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renderLocalInput } from '../src/compiler/render-local-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DATE_TEXT = 'writes a date as text of the time zone where it runs';

const ONE_VALUE = '(_s:TemplateStringsArray,value:unknown)=>';
const REST = '(_s:TemplateStringsArray,...values:unknown[])=>';
const ONE = `tag\`\${new Date(0)}\``;
const TEXT = "'Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)'";

/**
 * A custom tag that hands its Date substitution to a native string method that searches or splits
 * by it. Those methods convert the argument they search for to text (`includes`, `startsWith`,
 * `endsWith`, `indexOf`, `lastIndexOf`, `split`, `search`, `match`, `matchAll`), which for a Date is
 * the text of the time zone where it runs. `includes`, `indexOf` and `lastIndexOf` are also array
 * methods, which compare by identity and convert nothing: a receiver that holds the Date, or an
 * array literal, is that array. A position or a limit is a number and is read as one.
 */
const CASES = [
  { id: 'includes', tag: `${ONE_VALUE}${TEXT}.includes(value as string)`, local: DATE_TEXT },
  { id: 'startsWith', tag: `${ONE_VALUE}${TEXT}.startsWith(value as string)`, local: DATE_TEXT },
  { id: 'endsWith', tag: `${ONE_VALUE}${TEXT}.endsWith(value as string)`, local: DATE_TEXT },
  { id: 'indexOf', tag: `${ONE_VALUE}${TEXT}.indexOf(value as string)`, local: DATE_TEXT },
  { id: 'lastIndexOf', tag: `${ONE_VALUE}${TEXT}.lastIndexOf(value as string)`, local: DATE_TEXT },
  { id: 'split', tag: `${ONE_VALUE}'a b'.split(value as string)`, local: DATE_TEXT },
  { id: 'search', tag: `${ONE_VALUE}'a b'.search(value as string)`, local: DATE_TEXT },
  { id: 'match', tag: `${ONE_VALUE}'a b'.match(value as string)`, local: DATE_TEXT },
  { id: 'matchAll', tag: `${ONE_VALUE}'a b'.matchAll(value as never)`, local: DATE_TEXT },
  {
    id: 'includes-of-a-template-text',
    tag: `${ONE_VALUE}\`abc\`.includes(value as string)`,
    local: DATE_TEXT,
  },
  {
    id: 'includes-of-a-kept-text',
    tag: `${ONE_VALUE}{const text=${TEXT};return text.includes(value as string);}`,
    local: DATE_TEXT,
  },
  {
    id: 'includes-in-a-condition',
    tag: `${ONE_VALUE}${TEXT}.includes(value as string)?'in':'out'`,
    local: DATE_TEXT,
  },
  {
    id: 'includes-of-a-rest-substitution',
    tag: `${REST}${TEXT}.includes(values[0] as string)`,
    local: DATE_TEXT,
  },
  {
    id: 'includes-of-a-spread-argument',
    tag: `${REST}${TEXT}.includes(...(values as [string]))`,
    local: DATE_TEXT,
  },
  {
    id: 'startsWith-called-on-the-method',
    tag: `${ONE_VALUE}${TEXT}.startsWith.call(${TEXT},value)`,
    local: DATE_TEXT,
  },
  {
    id: 'includes-applied-with-a-list',
    tag: `${ONE_VALUE}${TEXT}.includes.apply(${TEXT},[value])`,
    local: DATE_TEXT,
  },
  {
    id: 'includes-borrowed-from-the-prototype',
    tag: `${ONE_VALUE}String.prototype.includes.call(${TEXT},value)`,
    local: DATE_TEXT,
  },
  {
    id: 'split-borrowed-from-the-prototype',
    tag: `${ONE_VALUE}String.prototype.split.call('a b',value)`,
    local: DATE_TEXT,
  },
  {
    id: 'startsWith-borrowed-with-the-date-as-the-text',
    tag: `${ONE_VALUE}String.prototype.startsWith.call(value,'T')`,
    local: DATE_TEXT,
  },
  {
    id: 'includes-of-an-array-of-text-is-refused-pin',
    tag: `${ONE_VALUE}{const names=['a','b'];return names.includes(value as string);}`,
    local: DATE_TEXT,
  },
  {
    id: 'includes-of-the-substitutions-pin',
    tag: `${REST}values.includes(values[0])`,
    local: undefined,
  },
  {
    id: 'indexOf-of-the-substitutions-pin',
    tag: `${REST}values.indexOf(values[0])`,
    local: undefined,
  },
  {
    id: 'lastIndexOf-of-the-substitutions-pin',
    tag: `${REST}values.lastIndexOf(values[0])`,
    local: undefined,
  },
  {
    id: 'includes-of-a-copy-of-the-substitutions-pin',
    tag: `${REST}[...values].includes(values[0])`,
    local: undefined,
  },
  {
    id: 'indexOf-of-an-array-the-tag-builds-pin',
    tag: `${ONE_VALUE}{const seen:unknown[]=[];if(seen.indexOf(value)<0){seen.push(value);}return seen.length+'';}`,
    local: undefined,
  },
  {
    id: 'includes-of-an-array-literal-pin',
    tag: `${ONE_VALUE}[1,2].includes(value as number)`,
    local: undefined,
  },
  {
    id: 'startsWith-of-a-date-iso-text-pin',
    tag: `${ONE_VALUE}(value as Date).toISOString().startsWith('1970')`,
    local: undefined,
  },
  {
    id: 'includes-of-the-time-pin',
    tag: `${ONE_VALUE}${TEXT}.includes(String((value as Date).getTime()))`,
    local: undefined,
  },
  {
    id: 'split-by-a-separator-pin',
    tag: `${ONE_VALUE}${TEXT}.split(' ').length+''`,
    local: undefined,
  },
  {
    id: 'startsWith-from-a-position-pin',
    tag: `${ONE_VALUE}${TEXT}.startsWith('T',value as number)`,
    local: undefined,
  },
  {
    id: 'indexOf-from-a-position-pin',
    tag: `${ONE_VALUE}${TEXT}.indexOf('T',value as number)`,
    local: undefined,
  },
  {
    id: 'split-with-a-limit-pin',
    tag: `${ONE_VALUE}'a b'.split(' ',value as number)`,
    local: undefined,
  },
  {
    id: 'at-with-a-date-position-pin',
    tag: `${ONE_VALUE}${TEXT}.at(value as number)`,
    local: undefined,
  },
] as const;

describe('native string methods that convert a Date they search or split by to text', () => {
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

  it('includes-of-a-substitution-that-is-not-a-date-pin', () => {
    const source = `export function Widget(){const tag=${ONE_VALUE}${TEXT}.includes(value as string);return <p>{tag\`\${'x'}\`}</p>;}`;

    expect(firstLocalInput(api, source)).toBeUndefined();
  });
});

function firstLocalInput(api: API, source: string): string | undefined {
  using parsed = parseModule(api, 'render-string-search-dates.tsx', source);
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
