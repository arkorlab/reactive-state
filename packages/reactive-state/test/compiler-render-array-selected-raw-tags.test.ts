import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { LOCAL_TIME } from '../src/compiler/local-date-inputs.ts';
import { renderDateConversion } from '../src/compiler/render-date-conversions.ts';
import { renderLocalInput } from '../src/compiler/render-local-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DATE_TEXT = 'writes a date as text of the time zone where it runs';

/** Array-selected, destructured, spread, mutated and indexed native String.raw tags retain Date text inputs. */
const CASES = [
  {
    id: 'const-tuple-String-raw-tag-const-date',
    source: `export function Widget(){const tags=[String.raw] as const;const date=new Date(0);return <p>{tags[0]\`\${date}\`}</p>;}`,
    conversion: LOCAL_TIME,
    local: DATE_TEXT,
  },
  {
    id: 'inline-array-literal-String-raw-tag',
    source: `export function Widget(){return <p>{[String.raw][0]!\`\${new Date(0)}\`}</p>;}`,
    conversion: LOCAL_TIME,
    local: DATE_TEXT,
  },
  {
    id: 'const-tuple-String-raw-stored-holder-date',
    source: `export function Widget(){const tags=[String.raw] as const;const holder={date:new Date(0)};return <p>{tags[0]\`\${holder.date}\`}</p>;}`,
    conversion: undefined,
    local: LOCAL_TIME,
  },
  {
    id: 'const-tuple-String-raw-date-array-substitution',
    source: `export function Widget(){const tags=[String.raw] as const;const dates=[new Date(0)];return <p>{tags[0]\`\${dates}\`}</p>;}`,
    conversion: LOCAL_TIME,
    local: undefined,
  },
  {
    id: 'const-tuple-String-raw-call-date-array',
    source: `export function Widget(){const tags=[String.raw] as const;const dates=[new Date(0)];return <p>{tags[0]({raw:["",""]},dates)}</p>;}`,
    conversion: LOCAL_TIME,
    local: undefined,
  },
  {
    id: 'const-index-second-slot-String-raw',
    source: `export function Widget(){const tags=[0,String.raw] as const;const idx=1;const date=new Date(0);return <p>{tags[idx]\`\${date}\`}</p>;}`,
    conversion: LOCAL_TIME,
    local: DATE_TEXT,
  },
  {
    id: 'nested-array-and-object-String-raw-tag',
    source: `export function Widget(){const grid=[[{raw:String.raw}]] as const;const date=new Date(0);return <p>{grid[0][0].raw\`\${date}\`}</p>;}`,
    conversion: LOCAL_TIME,
    local: DATE_TEXT,
  },
  {
    id: 'destructured-tuple-String-raw-tag',
    source: `export function Widget(){const [raw]=[String.raw];const date=new Date(0);return <p>{raw\`\${date}\`}</p>;}`,
    conversion: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'rest-destructured-array-String-raw-tag',
    source: `export function Widget(){const epoch=(_s:TemplateStringsArray,d:Date)=>d.toISOString();const [,...rest]=[epoch,String.raw];const date=new Date(0);return <p>{rest[0]!\`\${date}\`}</p>;}`,
    conversion: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'spread-inner-array-String-raw-tag',
    source: `export function Widget(){const epoch=(_s:TemplateStringsArray,d:Date)=>d.toISOString();const inner=[String.raw];const tags=[epoch,...inner];const date=new Date(0);return <p>{tags[1]!\`\${date}\`}</p>;}`,
    conversion: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'dynamic-index-array-containing-String-raw',
    source: `export function Widget({idx}:{idx:number}){const epoch=(_s:TemplateStringsArray,d:Date)=>d.toISOString();const tags=[epoch,String.raw];const date=new Date(0);return <p>{tags[idx]!\`\${date}\`}</p>;}`,
    conversion: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'mutated-array-slot-assigned-String-raw',
    source: `export function Widget(){const epoch=(_s:TemplateStringsArray,d:Date)=>d.toISOString();const tags:((s:TemplateStringsArray,d:Date)=>string)[]=[epoch];tags[0]=String.raw;const date=new Date(0);return <p>{tags[0]!\`\${date}\`}</p>;}`,
    conversion: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'reversed-array-moving-String-raw-slot',
    source: `export function Widget(){const epoch=(_s:TemplateStringsArray,d:Date)=>d.toISOString();const tags=[String.raw,epoch];tags.reverse();const date=new Date(0);return <p>{tags[1]!\`\${date}\`}</p>;}`,
    conversion: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'array-at-negative-index-String-raw',
    source: `export function Widget(){const epoch=(_s:TemplateStringsArray,d:Date)=>d.toISOString();const tags=[epoch,String.raw] as const;const date=new Date(0);return <p>{tags.at(-1)!\`\${date}\`}</p>;}`,
    conversion: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'popped-array-negative-at-String-raw',
    source: `export function Widget(){const epoch=(_s:TemplateStringsArray,d:Date)=>d.toISOString();const tags=[String.raw,epoch];tags.pop();const date=new Date(0);return <p>{tags.at(-1)!\`\${date}\`}</p>;}`,
    conversion: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'for-of-array-String-raw-tag',
    source: `export function Widget(){const date=new Date(0);for(const raw of [String.raw]){return <p>{raw\`\${date}\`}</p>;}return null;}`,
    conversion: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'unmutated-array-second-at-non-raw-pin',
    source: `export function Widget(){const epoch=(_s:TemplateStringsArray,d:Date)=>d.toISOString();const tags=[String.raw,epoch] as const;const date=new Date(0);return <p>{tags.at(1)!\`\${date}\`}</p>;}`,
    conversion: undefined,
    local: undefined,
  },
  {
    id: 'exact-custom-slot-beside-String-raw-pin',
    source: `export function Widget(){const epoch=(_s:TemplateStringsArray,d:Date)=>d.toISOString();const tags=[epoch,String.raw] as const;const date=new Date(0);return <p>{tags[0]\`\${date}\`}</p>;}`,
    conversion: undefined,
    local: undefined,
  },
  {
    id: 'exact-slot-before-later-spread-String-raw-pin',
    source: `export function Widget(){const epoch=(_s:TemplateStringsArray,d:Date)=>String(d.getTime());const tags=[epoch,...[String.raw]];const date=new Date(0);return <p>{tags[0]!\`\${date}\`}</p>;}`,
    conversion: undefined,
    local: undefined,
  },
  {
    id: 'dynamic-index-all-custom-array-pin',
    source: `export function Widget({idx}:{idx:number}){const a=(_s:TemplateStringsArray,d:Date)=>d.toISOString();const b=(_s:TemplateStringsArray,d:Date)=>String(d.getTime());const tags=[a,b];const date=new Date(0);return <p>{tags[idx]!\`\${date}\`}</p>;}`,
    conversion: undefined,
    local: undefined,
  },
  {
    id: 'parameter-array-dynamic-index-pin',
    source: `export function Widget({tags,idx}:{tags:readonly ((s:TemplateStringsArray,d:Date)=>string)[];idx:number}){const date=new Date(0);return <p>{tags[idx]!\`\${date}\`}</p>;}`,
    conversion: undefined,
    local: undefined,
  },
  {
    id: 'mutated-array-replacing-String-raw-conversion-pin',
    source: `export function Widget(){const tags:((s:TemplateStringsArray,v:unknown)=>string)[]=[String.raw];tags[0]=()=>"fixed";return <p>{tags[0]!\`\${[new Date(0)]}\`}</p>;}`,
    conversion: undefined,
    local: undefined,
  },
] as const;

describe('array-selected native String.raw date template tags', () => {
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
  using parsed = parseModule(api, 'render-array-selected-raw-tags.tsx', source);
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
