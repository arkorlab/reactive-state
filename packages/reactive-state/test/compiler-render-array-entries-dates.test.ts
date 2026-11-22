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
 * A custom tag that walks the index and value pairs of its Date substitutions. `entries()` answers
 * pairs that hold what the receiver holds, as `values()` answers the elements. The walk does not
 * tell the index of a pair from its value, so a pair read through a pattern whose index is written
 * as text is refused, where a `for...of` over `entries()` reads the index apart.
 */
const CASES = [
  {
    id: 'entries-spread-into-text',
    tag: `${REST}String([...values.entries()])`,
    local: DATE_TEXT,
  },
  {
    id: 'entries-from-an-array',
    tag: `${REST}Array.from(values.entries()).join(';')`,
    local: DATE_TEXT,
  },
  {
    id: 'entries-pairs-written-in-a-template',
    tag: `${REST}[...values.entries()].map(([index,value])=>\`\${index}:\${value}\`).join(',')`,
    local: DATE_TEXT,
  },
  {
    id: 'entries-mapped-by-array-from',
    tag: `${REST}Array.from(values.entries(),([index,value])=>index+':'+value).join(',')`,
    local: DATE_TEXT,
  },
  {
    id: 'entries-kept-then-written',
    tag: `${REST}{const pairs=[...values.entries()];return String(pairs);}`,
    local: DATE_TEXT,
  },
  {
    id: 'values-was-followed-pin',
    tag: `${REST}String([...values.values()])`,
    local: DATE_TEXT,
  },
  {
    id: 'for-of-entries-value-was-followed-pin',
    tag: `${REST}{let text='';for(const [,value] of values.entries()){text+=value;}return text;}`,
    local: DATE_TEXT,
  },
  {
    id: 'entries-of-times-without-the-index-pin',
    tag: `${REST_DATES}[...values.entries()].map(([,value])=>value.getTime()).join(',')`,
    local: undefined,
  },
  {
    id: 'entries-pair-index-written-as-text-is-refused-pin',
    tag: `${REST_DATES}[...values.entries()].map(([index,value])=>index+':'+value.getTime()).join(',')`,
    local: DATE_TEXT,
  },
  {
    id: 'keys-pin',
    tag: `${REST}String([...values.keys()])`,
    local: undefined,
  },
  {
    id: 'for-of-entries-index-pin',
    tag: `${REST}{let text='';for(const [index] of values.entries()){text+=index;}return text;}`,
    local: undefined,
  },
] as const;

describe('walking the entries of the Date substitutions of a tag', () => {
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

  it('entries-of-a-substitution-that-is-not-a-date-pin', () => {
    const source = `export function Widget(){const tag=${REST}String([...values.entries()]);return <p>{tag\`\${'b'}\`}</p>;}`;

    expect(firstLocalInput(api, source)).toBeUndefined();
  });
});

function firstLocalInput(api: API, source: string): string | undefined {
  using parsed = parseModule(api, 'render-array-entries-dates.tsx', source);
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
