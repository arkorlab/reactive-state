import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { LOCAL_TIME } from '../src/compiler/local-date-inputs.ts';
import { renderDateText } from '../src/compiler/render-date-text.ts';
import { renderLocalInput } from '../src/compiler/render-local-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DATE_TEXT = 'writes a date as text of the time zone where it runs';

/** Custom template tag wrappers that forward Date substitutions to native String.raw retain Date text inputs. */
const CASES = [
  {
    id: 'arrow-rest-wrapper-String-raw-const-date',
    source: `export function Widget(){const raw=(s:TemplateStringsArray,...v:unknown[])=>String.raw(s,...v);const date=new Date(0);return <p>{raw\`\${date}\`}</p>;}`,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'arrow-raw-object-wrapper-String-raw-new-date',
    source: `export function Widget(){const html=(s:TemplateStringsArray,...v:unknown[])=>String.raw({raw:s},...v);return <p>{html\`\${new Date(0)}\`}</p>;}`,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'destructured-raw-param-wrapper-String-raw',
    source: `export function Widget(){const html=({ raw }:TemplateStringsArray,...v:unknown[])=>String.raw({ raw },...v);const date=new Date(0);return <p>{html\`\${date}\`}</p>;}`,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'function-declaration-wrapper-String-raw-typed-date',
    source: `export function Widget(date:Date){function raw(s:TemplateStringsArray,...v:unknown[]){return String.raw(s,...v);}return <p>{raw\`\${date}\`}</p>;}`,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'arrow-wrapper-String-raw-stored-holder-date',
    source: `export function Widget(){const raw=(s:TemplateStringsArray,...v:unknown[])=>String.raw(s,...v);const holder={date:new Date(0)};return <p>{raw\`\${holder.date}\`}</p>;}`,
    dateText: LOCAL_TIME,
    local: LOCAL_TIME,
  },
  {
    id: 'function-wrapper-raw-object-stored-holder-date',
    source: `export function Widget(){function html(s:TemplateStringsArray,...v:unknown[]){return String.raw({raw:s},...v);}const holder={date:new Date(0)};return <p>{html\`\${holder.date}\`}</p>;}`,
    dateText: LOCAL_TIME,
    local: LOCAL_TIME,
  },
  {
    id: 'positional-param-wrapper-String-raw-call',
    source: `export function Widget(){const raw=(s:TemplateStringsArray,d:unknown)=>String.raw(s,d);const date=new Date(0);return <p>{raw\`\${date}\`}</p>;}`,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'positional-param-wrapper-String-raw-template-stored-date',
    source: `export function Widget(){const raw=(_s:TemplateStringsArray,d:unknown)=>String.raw\`\${d}\`;const holder={date:new Date(0)};return <p>{raw\`\${holder.date}\`}</p>;}`,
    dateText: LOCAL_TIME,
    local: LOCAL_TIME,
  },
  {
    id: 'trimmed-String-raw-wrapper-stored-holder-date',
    source: `export function Widget(){const sql=(s:TemplateStringsArray,...v:unknown[])=>String.raw(s,...v).trim();const holder={date:new Date(0)};return <p>{sql\`\${holder.date}\`}</p>;}`,
    dateText: LOCAL_TIME,
    local: LOCAL_TIME,
  },
  {
    id: 'object-method-wrapper-String-raw',
    source: `export function Widget(){const tags={raw(s:TemplateStringsArray,...v:unknown[]){return String.raw(s,...v);}};const holder={date:new Date(0)};return <p>{tags.raw\`\${holder.date}\`}</p>;}`,
    dateText: LOCAL_TIME,
    local: LOCAL_TIME,
  },
  {
    id: 'Reflect-apply-arguments-wrapper-String-raw',
    source: `export function Widget(){function raw(_s:TemplateStringsArray,..._v:unknown[]){return Reflect.apply(String.raw,String,arguments);}const date=new Date(0);return <p>{raw\`\${date}\`}</p>;}`,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'chained-and-bound-wrapper-String-raw',
    source: `export function Widget(){const inner=(s:TemplateStringsArray,...v:unknown[])=>String.raw(s,...v);const outer=(s:TemplateStringsArray,...v:unknown[])=>inner(s,...v);const date=new Date(0);return <p>{outer.bind(null)\`\${date}\`}</p>;}`,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'wrapper-converting-toISOString-before-String-raw-pin',
    source: `export function Widget(){const raw=(_s:TemplateStringsArray,d:Date)=>String.raw\`\${d.toISOString()}\`;const date=new Date(0);return <p>{raw\`\${date}\`}</p>;}`,
    dateText: undefined,
    local: undefined,
  },
  {
    id: 'wrapper-static-String-raw-ignoring-date-pin',
    source: `export function Widget(){const raw=(_s:TemplateStringsArray,_d:Date)=>String.raw\`fixed\`;const holder={date:new Date(0)};return <p>{raw\`\${holder.date}\`}</p>;}`,
    dateText: undefined,
    local: undefined,
  },
  {
    id: 'wrapper-forwarding-only-first-span-when-date-in-second-pin',
    source: `export function Widget(){const raw=(_s:TemplateStringsArray,first:string,_second:Date)=>String.raw\`\${first}\`;const holder={date:new Date(0)};return <p>{raw\`\${"ok"}\${holder.date}\`}</p>;}`,
    dateText: undefined,
    local: undefined,
  },
  {
    id: 'wrapper-fixed-single-raw-segment-call-pin',
    source: `export function Widget(){const raw=(_s:TemplateStringsArray,...v:unknown[])=>String.raw({raw:["fixed"]},...v);const date=new Date(0);return <p>{raw\`\${date}\`}</p>;}`,
    dateText: undefined,
    local: undefined,
  },
  {
    id: 'wrapper-calling-shadowed-String-raw-pin',
    source: `export function Widget(){const String={raw:(_s:TemplateStringsArray,..._v:unknown[])=>"fixed"};const raw=(s:TemplateStringsArray,...v:unknown[])=>String.raw(s,...v);const holder={date:new Date(0)};return <p>{raw\`\${holder.date}\`}</p>;}`,
    dateText: undefined,
    local: undefined,
  },
  {
    id: 'object-method-returning-UTC-pin',
    source: `export function Widget(){const tags={raw(_s:TemplateStringsArray,d:Date){return d.toUTCString();}};const date=new Date(0);return <p>{tags.raw\`\${date}\`}</p>;}`,
    dateText: undefined,
    local: undefined,
  },
] as const;

describe('wrapped native String.raw date template tags', () => {
  it.each(CASES)('$id', ({ source, dateText, local }) => {
    expect({
      dateText: firstReaderInput(source, renderDateText),
      local: firstReaderInput(source, renderLocalInput),
    }).toStrictEqual({ dateText, local });
  });
});

function firstReaderInput(
  source: string,
  reader: (node: Node) => string | undefined,
): string | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'render-wrapped-raw-date-tags.tsx', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    const found = reader(node);
    if (found !== undefined) return found;
    const children: Node[] = [];
    node.forEachChild((child) => {
      children.push(child);
    });
    pending.push(...children.toReversed());
  }
  return undefined;
}
