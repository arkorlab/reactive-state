import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { renderLocalInput } from '../src/compiler/render-local-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DATE_TEXT = 'writes a date as text of the time zone where it runs';

/** Tagged templates pass direct Date values raw to the tag unless native String.raw converts them to text. */
const CASES = [
  {
    id: 'tagged-const-date-identifier',
    source: `export function Widget(){function epoch(_strings:TemplateStringsArray,date:Date){return String(date.getTime());}const now=new Date(0);return <p>{epoch\`\${now}\`}</p>;}`,
    input: undefined,
  },
  {
    id: 'tagged-direct-new-date',
    source: `export function Widget(){const tag=(_strings:TemplateStringsArray,date:Date)=>date.toISOString();return <p>{tag\`\${new Date(0)}\`}</p>;}`,
    input: undefined,
  },
  {
    id: 'tagged-typed-date-parameter',
    source: `export function Widget(now:Date){const tag=(_strings:TemplateStringsArray,date:Date)=>String(date.valueOf());return <p>{tag\`\${now}\`}</p>;}`,
    input: undefined,
  },
  {
    id: 'tagged-typed-date-variable',
    source: `export function Widget({make}:{make:()=>Date}){const tag=(_strings:TemplateStringsArray,date:Date)=>date.toUTCString();const now:Date=make();return <p>{tag\`\${now}\`}</p>;}`,
    input: undefined,
  },
  {
    id: 'tagged-inline-arrow-second-span-date',
    source: `export function Widget(){const now=new Date(0);return <p>{((_strings:TemplateStringsArray,_prefix:string,date:Date)=>String(date.getTime()))\`\${"at"}:\${now}\`}</p>;}`,
    input: undefined,
  },
  {
    id: 'tagged-member-callee-date-alias',
    source: `export function Widget({sql}:{sql:{query:(strings:TemplateStringsArray,date:Date)=>string}}){const first=new Date(0);const now=first;return <p>{sql.query\`SELECT \${now}\`}</p>;}`,
    input: undefined,
  },
  {
    id: 'tagged-shadowed-String-raw-date',
    source: `export function Widget(){const String={raw:(_strings:TemplateStringsArray,date:Date)=>date.toISOString()};const now=new Date(0);return <p>{String.raw\`\${now}\`}</p>;}`,
    input: undefined,
  },
  {
    id: 'native-String-raw-const-date',
    source: `export function Widget(){const now=new Date(0);return <p>{String.raw\`\${now}\`}</p>;}`,
    input: DATE_TEXT,
  },
  {
    id: 'native-String-raw-alias-date-parameter',
    source: `export function Widget(now:Date){const raw=String.raw;return <p>{raw\`\${now}\`}</p>;}`,
    input: DATE_TEXT,
  },
  {
    id: 'native-globalThis-String-raw-new-date',
    source: `export function Widget({ms}:{ms:number}){return <p>{globalThis.String["raw"]\`\${new Date(ms)}\`}</p>;}`,
    input: DATE_TEXT,
  },
  {
    id: 'untagged-template-const-date',
    source: `export function Widget(){const now=new Date(0);return <p>{\`at:\${now}\`}</p>;}`,
    input: DATE_TEXT,
  },
  {
    id: 'tagged-outer-with-untagged-inner-const-date',
    source: `export function Widget(){const tag=(_strings:TemplateStringsArray,text:string)=>text;const now=new Date(0);return <p>{tag\`\${\`\${now}\`}\`}</p>;}`,
    input: DATE_TEXT,
  },
  {
    id: 'tag-callee-arg-untagged-const-date',
    source: `export function Widget(){const makeTag=(_label:string)=>(_strings:TemplateStringsArray)=>"fixed";const now=new Date(0);return <p>{makeTag(\`\${now}\`)\`ok\`}</p>;}`,
    input: DATE_TEXT,
  },
] as const;

describe('direct date values in tagged and untagged templates', () => {
  it.each(CASES)('$id', ({ source, input }) => {
    expect(firstLocalInput(source)).toBe(input);
  });
});

function firstLocalInput(source: string): string | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'render-local-tagged-date-templates.tsx', source);
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
