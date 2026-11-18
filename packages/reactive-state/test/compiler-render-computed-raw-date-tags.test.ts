import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { renderDateConversion } from '../src/compiler/render-date-conversions.ts';
import { renderLocalInput } from '../src/compiler/render-local-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DATE_TEXT = 'writes a date as text of the time zone where it runs';
const LOCAL_TIME = 'Date.localTime';

/** Computed, aliased and conditional native String.raw tags still convert Date values in local time. */
const CASES = [
  {
    id: 'const-key-String-raw-tag-const-date',
    source: `export function Widget(){const key="raw";const date=new Date(0);return <p>{String[key]\`\${date}\`}</p>;}`,
    conversion: LOCAL_TIME,
    local: DATE_TEXT,
  },
  {
    id: 'const-key-alias-chain-typed-date',
    source: `export function Widget(date:Date){const first="raw";const key=first;return <p>{String[key]\`\${date}\`}</p>;}`,
    conversion: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'const-template-key-String-raw-tag',
    source: `export function Widget(){const key=\`raw\`;return <p>{String[key]\`\${new Date(0)}\`}</p>;}`,
    conversion: LOCAL_TIME,
    local: DATE_TEXT,
  },
  {
    id: 'const-alias-of-computed-String-raw-array',
    source: `export function Widget(){const key="raw";const raw=String[key];const dates=[new Date(0)];return <p>{raw\`\${dates}\`}</p>;}`,
    conversion: LOCAL_TIME,
    local: undefined,
  },
  {
    id: 'const-String-alias-computed-raw-array',
    source: `export function Widget(){const Str=String;const key="raw";const dates=[new Date(0)];return <p>{Str[key]\`\${dates}\`}</p>;}`,
    conversion: LOCAL_TIME,
    local: undefined,
  },
  {
    id: 'const-String-alias-computed-raw-stored-date',
    source: `export function Widget(){const Str=String;const key="raw";const holder={date:new Date(0)};return <p>{Str[key]\`\${holder.date}\`}</p>;}`,
    conversion: undefined,
    local: LOCAL_TIME,
  },
  {
    id: 'globalThis-computed-String-and-raw-keys',
    source: `export function Widget(){const holderKey="String";const memberKey="raw";return <p>{globalThis[holderKey][memberKey]\`\${new Date(0)}\`}</p>;}`,
    conversion: LOCAL_TIME,
    local: DATE_TEXT,
  },
  {
    id: 'const-key-String-raw-call-date-array',
    source: `export function Widget(){const key="raw";const dates=[new Date(0)];return <p>{String[key]({raw:["",""]},dates)}</p>;}`,
    conversion: LOCAL_TIME,
    local: undefined,
  },
  {
    id: 'conditional-key-String-raw-tag-date',
    source: `export function Widget({flag}:{flag:boolean}){const date=new Date(0);return <p>{String[flag?"raw":"fromCharCode"]\`\${date}\`}</p>;}`,
    conversion: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'dynamic-string-key-String-tag-date',
    source: `export function Widget({key}:{key:string}){const date=new Date(0);return <p>{String[key]\`\${date}\`}</p>;}`,
    conversion: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'conditional-tag-String-raw-or-custom',
    source: `export function Widget({flag}:{flag:boolean}){const epoch=(_s:TemplateStringsArray,date:Date)=>String(date.getTime());const date=new Date(0);return <p>{(flag?String.raw:epoch)\`\${date}\`}</p>;}`,
    conversion: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'destructured-computed-String-raw-tag',
    source: `export function Widget(){const key="raw";const {[key]:raw}=String;const date=new Date(0);return <p>{raw\`\${date}\`}</p>;}`,
    conversion: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'reflected-String-raw-computed-key-tag',
    source: `export function Widget(){const key="raw";const date=new Date(0);return <p>{Reflect.get(String,key)\`\${date}\`}</p>;}`,
    conversion: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'const-non-raw-String-member-pin',
    source: `export function Widget(){const key="fromCharCode";const date=new Date(0);return <p>{(String[key] as unknown as (s:TemplateStringsArray,d:Date)=>string)\`\${date}\`}</p>;}`,
    conversion: undefined,
    local: undefined,
  },
  {
    id: 'shadowed-String-computed-raw-key-pin',
    source: `export function Widget(){const String={raw:(_s:TemplateStringsArray,date:Date)=>date.toISOString()};const key="raw";const date=new Date(0);return <p>{String[key]\`\${date}\`}</p>;}`,
    conversion: undefined,
    local: undefined,
  },
  {
    id: 'application-object-computed-raw-key-pin',
    source: `export function Widget(){const tags={raw:(_s:TemplateStringsArray,date:Date)=>String(date.getTime())};const key="raw";const date=new Date(0);return <p>{tags[key]\`\${date}\`}</p>;}`,
    conversion: undefined,
    local: undefined,
  },
  {
    id: 'parameter-record-dynamic-key-tag-pin',
    source: `export function Widget({tags,key}:{tags:Record<string,(s:TemplateStringsArray,d:Date)=>string>;key:string}){const date=new Date(0);return <p>{tags[key]!\`\${date}\`}</p>;}`,
    conversion: undefined,
    local: undefined,
  },
  {
    id: 'prior-String-computed-raw-overwrite-pin',
    source: `export function Widget(){const key="raw";(String as unknown as Record<string,unknown>)[key]=()=>"fixed";return <p>{String[key]\`\${[new Date(0)]}\`}</p>;}`,
    conversion: undefined,
    local: undefined,
  },
  {
    id: 'literal-bracket-String-raw-pin',
    source: `export function Widget(){const date=new Date(0);return <p>{String["raw"]\`\${date}\`}</p>;}`,
    conversion: LOCAL_TIME,
    local: DATE_TEXT,
  },
] as const;

describe('computed and aliased String.raw date template inputs', () => {
  it.each(CASES)('$id', ({ source, conversion, local }) => {
    expect({
      conversion: firstReaderInput(source, renderDateConversion),
      local: firstReaderInput(source, renderLocalInput),
    }).toStrictEqual({ conversion, local });
  });
});

function firstReaderInput(
  source: string,
  reader: (node: Node) => string | undefined,
): string | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'render-computed-raw-date-tags.tsx', source);
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
