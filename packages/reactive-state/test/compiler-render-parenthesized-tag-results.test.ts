import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renderLocalInput } from '../src/compiler/render-local-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DATE_TEXT = 'writes a date as text of the time zone where it runs';

const RETURNS_IT = '(_s:TemplateStringsArray,date:unknown)=>date';
const RETURNS_TIME = '(_s:TemplateStringsArray,date:unknown)=>(date as Date).getTime()';
const USE = `tag\`\${new Date(0)}\``;

/**
 * What a custom tag answers is a Date when the tag returns its substitution, and the page that
 * writes the answer as text (`String(tag\`${date}\`)`, `new String(...)`, a template, `+`) writes it
 * in the time zone where it runs. Parentheses, a cast and `!` around the tagged template change
 * nothing about that, and they are written for types, so they are common.
 */
const CASES = [
  { id: 'String-of-the-answer-pin', tag: RETURNS_IT, use: `String(${USE})`, local: DATE_TEXT },
  {
    id: 'String-of-the-answer-in-parentheses',
    tag: RETURNS_IT,
    use: `String((${USE}))`,
    local: DATE_TEXT,
  },
  {
    id: 'String-of-the-answer-in-two-parentheses',
    tag: RETURNS_IT,
    use: `String(((${USE})))`,
    local: DATE_TEXT,
  },
  {
    id: 'String-of-the-answer-cast',
    tag: RETURNS_IT,
    use: `String(${USE} as unknown)`,
    local: DATE_TEXT,
  },
  {
    id: 'String-of-the-answer-cast-in-parentheses',
    tag: RETURNS_IT,
    use: `String((${USE} as unknown))`,
    local: DATE_TEXT,
  },
  {
    id: 'String-of-the-answer-asserted-non-null',
    tag: RETURNS_IT,
    use: `String(${USE}!)`,
    local: DATE_TEXT,
  },
  {
    id: 'new-String-of-the-answer-in-parentheses',
    tag: RETURNS_IT,
    use: `new String((${USE}))`,
    local: DATE_TEXT,
  },
  {
    id: 'toString-of-the-answer-in-parentheses-pin',
    tag: RETURNS_IT,
    use: `(${USE}).toString()`,
    local: DATE_TEXT,
  },
  {
    id: 'added-to-text-in-parentheses-pin',
    tag: RETURNS_IT,
    use: `'at:'+(${USE})`,
    local: DATE_TEXT,
  },
  {
    id: 'written-in-a-template-pin',
    tag: RETURNS_IT,
    use: `\`at:\${(${USE})}\``,
    local: DATE_TEXT,
  },
  {
    id: 'String-of-a-time-in-parentheses-pin',
    tag: RETURNS_TIME,
    use: `String((${USE}))`,
    local: undefined,
  },
  {
    id: 'String-of-a-time-cast-pin',
    tag: RETURNS_TIME,
    use: `String(${USE} as unknown)`,
    local: undefined,
  },
  {
    id: 'answer-kept-as-a-date-in-parentheses-pin',
    tag: RETURNS_IT,
    use: `(${USE})`,
    local: undefined,
  },
] as const;

describe('the answer of a tag that returns its Date, written as text through parentheses and casts', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ tag, use, local }) => {
    const source = `export function Widget(){const tag=${tag};return <p>{${use}}</p>;}`;

    expect(firstLocalInput(api, source)).toBe(local);
  });
});

function firstLocalInput(api: API, source: string): string | undefined {
  using parsed = parseModule(api, 'render-parenthesized-tag-results.tsx', source);
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
