import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { renderDateText } from '../src/compiler/render-date-text.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Tagged templates pass stored Date projections raw to the tag; untagged templates still convert them to text. */
const CASES = [
  {
    id: 'tagged-function-object-stored-date',
    source: `export function Widget(){function epoch(_strings:TemplateStringsArray,date:Date){return String(date.getTime());}const holder={date:new Date(0)};return <p>{epoch\`\${holder.date}\`}</p>;}`,
    input: undefined,
  },
  {
    id: 'tagged-const-array-stored-date',
    source: `export function Widget(){const tag=(_strings:TemplateStringsArray,date:Date)=>String(date.getUTCFullYear());const dates=[new Date(0)];return <p>{tag\`\${dates[0]!}\`}</p>;}`,
    input: undefined,
  },
  {
    id: 'tagged-parameter-nested-stored-date',
    source: `export function Widget({tag}:{tag:(strings:TemplateStringsArray,date:Date)=>string}){const box={dates:[{at:new Date(0)}]};return <p>{tag\`\${box.dates[0]!.at}\`}</p>;}`,
    input: undefined,
  },
  {
    id: 'tagged-inline-arrow-stored-date',
    source: `export function Widget(){const holder={date:new Date(0)};return <p>{((_strings:TemplateStringsArray,date:Date)=>String(date.getTime()))\`\${holder.date}\`}</p>;}`,
    input: undefined,
  },
  {
    id: 'tagged-second-span-stored-date',
    source: `export function Widget(){const tag=(_strings:TemplateStringsArray,_label:string,date:Date)=>String(date.valueOf());const holder={date:new Date(0)};return <p>{tag\`\${"t"}:\${holder.date}\`}</p>;}`,
    input: undefined,
  },
  {
    id: 'tagged-immediate-object-date',
    source: `export function Widget(){const tag=(_strings:TemplateStringsArray,date:Date)=>date.toISOString();return <p>{tag\`\${({date:new Date(0)}).date}\`}</p>;}`,
    input: undefined,
  },
  {
    id: 'untagged-template-stored-date',
    source: `export function Widget(){const holder={date:new Date(0)};return <p>{\`date:\${holder.date}\`}</p>;}`,
    input: 'Date.localTime',
  },
  {
    id: 'untagged-second-span-stored-date',
    source: `export function Widget(){const holder={date:new Date(0)};return <p>{\`\${"date"}:\${holder.date}\`}</p>;}`,
    input: 'Date.localTime',
  },
  {
    id: 'call-with-untagged-template-argument',
    source: `export function Widget(){const wrap=(text:string)=>text;const holder={date:new Date(0)};return <p>{wrap(\`\${holder.date}\`)}</p>;}`,
    input: 'Date.localTime',
  },
  {
    id: 'tagged-outer-with-untagged-inner-substitution',
    source: `export function Widget(){const tag=(_strings:TemplateStringsArray,text:string)=>text;const holder={date:new Date(0)};return <p>{tag\`\${\`\${holder.date}\`}\`}</p>;}`,
    input: 'Date.localTime',
  },
  {
    id: 'tag-callee-evaluates-untagged-template',
    source: `export function Widget(){const makeTag=(_label:string)=>(_strings:TemplateStringsArray)=>"fixed";const holder={date:new Date(0)};return <p>{makeTag(\`\${holder.date}\`)\`ok\`}</p>;}`,
    input: 'Date.localTime',
  },
] as const;

describe('stored date text in tagged and untagged templates', () => {
  it.each(CASES)('$id', ({ source, input }) => {
    expect(firstDateText(source)).toBe(input);
  });
});

function firstDateText(source: string): string | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'render-date-tagged-templates.tsx', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    const found = renderDateText(node);
    if (found !== undefined) return found;
    const children: Node[] = [];
    node.forEachChild((child) => {
      children.push(child);
    });
    pending.push(...children.toReversed());
  }
  return undefined;
}
