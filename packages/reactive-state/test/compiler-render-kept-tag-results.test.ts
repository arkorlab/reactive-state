import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { renderLocalInput } from '../src/compiler/render-local-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DATE_TEXT = 'writes a date as text of the time zone where it runs';

const RETURNS_IT = '(_s:TemplateStringsArray,v:unknown)=>v';
const USE = `tag\`\${new Date(0)}\``;

/** The markup that writes `shown` as the text of a paragraph. */
const page = (shown: string): string => ['return <p>{', shown, '}</p>;'].join('');

interface Row {
  readonly id: string;
  /** The body of the component: statements, ending in the `return` of its markup. */
  readonly body: string;
}

/**
 * A tag that returns its Date substitution answers a Date, and a result kept in a binding is read
 * by whatever converts it later: the page writes it as text in the time zone where it runs.
 */
const KEPT_AND_CONVERTED: readonly Row[] = [
  {
    id: 'String of the kept result',
    body: `const tag=${RETURNS_IT};const result=${USE};return <p>{String(result)}</p>;`,
  },
  {
    id: 'a template span of the kept result',
    body: `const tag=${RETURNS_IT};const result=${USE};return <p>{\`\${result}\`}</p>;`,
  },
  {
    id: 'plus on the kept result',
    body: `const tag=${RETURNS_IT};const result=${USE};return <p>{"at:"+result}</p>;`,
  },
  {
    id: 'toString of the kept result',
    body: `const tag=${RETURNS_IT};const result=${USE};return <p>{(result as Date).toString()}</p>;`,
  },
  {
    id: 'join of the kept values of a tag that returns them',
    body: `const tag=(_s:TemplateStringsArray,...v:unknown[])=>v;const r=${USE};return <p>{r.join(",")}</p>;`,
  },
  {
    id: 'String of a kept result typed as a Date',
    body: `const tag=(_s:TemplateStringsArray,v:Date)=>v;const r=${USE};return <p>{String(r)}</p>;`,
  },
];

/**
 * What it costs, said plainly: the kept result of an identity tag read through `getTime()` or
 * `toISOString()` is refused too, though Node prints a number or ISO text. The tree cannot tell, at
 * the declaration, how the binding is read later; no file of the corpus keeps such a result.
 */
const KEPT_AND_READ_AS_A_DATE: readonly Row[] = [
  {
    id: 'getTime of the kept result',
    body: `const tag=${RETURNS_IT};const result=${USE};return <p>{(result as Date).getTime()}</p>;`,
  },
  {
    id: 'toISOString of the kept result',
    body: `const tag=${RETURNS_IT};const result=${USE};return <p>{(result as Date).toISOString()}</p>;`,
  },
  {
    id: 'getTime of a kept result typed as a Date',
    body: `const tag=(_s:TemplateStringsArray,v:Date)=>v;const r=${USE};return <p>{r.getTime()}</p>;`,
  },
  {
    id: 'toISOString of a kept result typed as a Date',
    body: `const tag=(_s:TemplateStringsArray,v:Date)=>v;const r=${USE};return <p>{r.toISOString()}</p>;`,
  },
];

/** The conversion written next to the template, as before. */
const CONVERTED_AT_THE_TEMPLATE: readonly Row[] = [
  {
    id: 'String of the tagged template',
    body: `const tag=${RETURNS_IT};return <p>{String(${USE})}</p>;`,
  },
  {
    id: 'plus on the tagged template',
    body: `const tag=${RETURNS_IT};return <p>{"at:"+${USE}}</p>;`,
  },
  {
    id: 'a tag that converts its substitution itself, kept',
    body: `const tag=(_s:TemplateStringsArray,v:unknown)=>String(v);const result=${USE};${page('result')}`,
  },
];

/** A tag whose answer is not the Date, kept in a binding, is taken, as before. */
const ORDINARY_TAGS: readonly Row[] = [
  {
    id: 'a tag that answers the time',
    body: `const tag=(_s:TemplateStringsArray,d:Date)=>String(d.getTime());const result=${USE};${page('result')}`,
  },
  {
    id: 'a tag that answers ISO text',
    body: `const tag=(_s:TemplateStringsArray,d:Date)=>d.toISOString();const result=${USE};${page('result')}`,
  },
  {
    id: 'an html tag that writes ISO text',
    body: `const html=(s:TemplateStringsArray,...v:Date[])=>s.raw.map((x,i)=>x+(v[i]?.toISOString()??"")).join("");const result=html\`<b>\${new Date(0)}</b>\`;${page('result')}`,
  },
  {
    id: 'a kept result of a tag that returns a stored date',
    body: `const holder={date:new Date(0)};const tag=${RETURNS_IT};const result=tag\`\${holder.date}\`;return <p>{String(result)}</p>;`,
  },
  {
    id: 'a descriptor object of a tag, kept',
    body: `const sql=(s:TemplateStringsArray,...v:unknown[])=>({s,v});const q=sql\`x \${new Date(0)}\`;${page('q.v.length')}`,
  },
  {
    id: 'a result assigned to a variable declared before',
    body: `const tag=${RETURNS_IT};let r:unknown;r=${USE};return <p>{String(r)}</p>;`,
  },
  {
    id: 'a result handed to a helper',
    body: `const tag=${RETURNS_IT};const show=(x:unknown)=>String(x);return <p>{show(${USE})}</p>;`,
  },
  {
    id: 'a result held by an object',
    body: `const tag=${RETURNS_IT};const o={when:${USE}};return <p>{String(o.when)}</p>;`,
  },
];

describe('the result of a tag that returns its Date substitution, kept in a binding', () => {
  it.each(KEPT_AND_CONVERTED.map((row) => [row.id, row] as const))(
    'is read as a Date written as text for %s',
    (_id, row) => {
      expect(firstLocalInput(row.body)).toBe(DATE_TEXT);
    },
  );

  it.each(KEPT_AND_READ_AS_A_DATE.map((row) => [row.id, row] as const))(
    'is refused too for %s',
    (_id, row) => {
      expect(firstLocalInput(row.body)).toBe(DATE_TEXT);
    },
  );

  it.each(CONVERTED_AT_THE_TEMPLATE.map((row) => [row.id, row] as const))(
    'answers as before for %s',
    (_id, row) => {
      expect(firstLocalInput(row.body)).toBe(DATE_TEXT);
    },
  );

  it.each(ORDINARY_TAGS.map((row) => [row.id, row] as const))(
    'is taken, as before, for %s',
    (_id, row) => {
      expect(firstLocalInput(row.body)).toBeUndefined();
    },
  );
});

/** What the reader of local inputs answers for the first node of the component that has one. */
function firstLocalInput(body: string): string | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'kept-tag-results.tsx', `export function Widget(){${body}}`);
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) {
      continue;
    }
    const found = renderLocalInput(node);
    if (found !== undefined) {
      return found;
    }
    const children: Node[] = [];
    node.forEachChild((child) => {
      children.push(child);
    });
    pending.push(...children.toReversed());
  }
  return undefined;
}
