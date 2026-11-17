import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LOCAL_TIME } from '../src/compiler/local-date-inputs.ts';
import { renderDateConversion } from '../src/compiler/render-date-conversions.ts';
import { renderDateText } from '../src/compiler/render-date-text.ts';
import { renderLocalInput } from '../src/compiler/render-local-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DATE_TEXT = 'writes a date as text of the time zone where it runs';

/** Custom text-coercing template tags and outer-owned raw containers retain Date timezone inputs. */
const CASES = [
  {
    id: 'arrow-String-call-unknown-param-const-date',
    source: `export function Widget(){const text=(_s:TemplateStringsArray,value:unknown)=>String(value);const date=new Date(0);return <p>{text\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'arrow-String-call-unknown-param-stored-holder-date',
    source: `export function Widget(){const text=(_s:TemplateStringsArray,value:unknown)=>String(value);const holder={date:new Date(0)};return <p>{text\`\${holder.date}\`}</p>;}`,
    conversion: undefined,
    dateText: LOCAL_TIME,
    local: LOCAL_TIME,
  },
  {
    id: 'new-String-constructor-unknown-param-const-date',
    source: `export function Widget(){const text=(_s:TemplateStringsArray,value:unknown)=>new String(value).valueOf();const date=new Date(0);return <p>{text\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'untagged-template-coercion-const-date',
    source: `export function Widget(){const text=(_s:TemplateStringsArray,value:unknown)=>\`at:\${value}\`;const date=new Date(0);return <p>{text\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'untagged-template-coercion-stored-holder-date',
    source: `export function Widget(){const text=(_s:TemplateStringsArray,value:unknown)=>\`at:\${value}\`;const holder={date:new Date(0)};return <p>{text\`\${holder.date}\`}</p>;}`,
    conversion: undefined,
    dateText: LOCAL_TIME,
    local: LOCAL_TIME,
  },
  {
    id: 'binary-plus-concatenation-typed-date-param',
    source: `export function Widget(date:Date){const text=(_s:TemplateStringsArray,value:unknown)=>value+"";return <p>{text\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'binary-plus-concatenation-stored-holder-date',
    source: `export function Widget(){const text=(_s:TemplateStringsArray,value:unknown)=>""+value;const holder={date:new Date(0)};return <p>{text\`\${holder.date}\`}</p>;}`,
    conversion: undefined,
    dateText: LOCAL_TIME,
    local: LOCAL_TIME,
  },
  {
    id: 'plus-equals-loop-accumulation-rest-values',
    source: `export function Widget(){function text(s:TemplateStringsArray,...values:unknown[]){let out=s[0]??"";for(const v of values)out+=v;return out;}const date=new Date(0);return <p>{text\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'rest-values-join-const-date',
    source: `export function Widget(){const text=(_s:TemplateStringsArray,...values:unknown[])=>values.join("");const date=new Date(0);return <p>{text\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'rest-values-join-stored-holder-date',
    source: `export function Widget(){const text=(_s:TemplateStringsArray,...values:unknown[])=>values.join(",");const holder={date:new Date(0)};return <p>{text\`\${holder.date}\`}</p>;}`,
    conversion: undefined,
    dateText: LOCAL_TIME,
    local: LOCAL_TIME,
  },
  {
    id: 'array-literal-toString-const-date',
    source: `export function Widget(){const text=(_s:TemplateStringsArray,value:unknown)=>[value].toString();const date=new Date(0);return <p>{text\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'string-concat-method-const-date',
    source: `export function Widget(){const text=(_s:TemplateStringsArray,value:unknown)=>"".concat(value as string);const date=new Date(0);return <p>{text\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'string-padStart-fill-const-date',
    source: `export function Widget(){const text=(_s:TemplateStringsArray,value:unknown)=>"x".padStart(2,value as string);const date=new Date(0);return <p>{text\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'direct-toString-method-unknown-param-stored-date',
    source: `export function Widget(){const text=(_s:TemplateStringsArray,value:{toString():string})=>value.toString();const holder={date:new Date(0)};return <p>{text\`\${holder.date}\`}</p>;}`,
    conversion: undefined,
    dateText: LOCAL_TIME,
    local: LOCAL_TIME,
  },
  {
    id: 'direct-toDateString-method-cast-const-date',
    source: `export function Widget(){const text=(_s:TemplateStringsArray,value:unknown)=>(value as Date).toDateString();const date=new Date(0);return <p>{text\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'borrowed-Date-prototype-toTimeString-call-const-date',
    source: `export function Widget(){const text=(_s:TemplateStringsArray,value:unknown)=>Date.prototype.toTimeString.call(value);const date=new Date(0);return <p>{text\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'local-helper-forwarding-String-const-date',
    source: `export function Widget(){const fmt=(x:unknown)=>String(x);const text=(_s:TemplateStringsArray,value:unknown)=>fmt(value);const date=new Date(0);return <p>{text\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'local-helper-forwarding-String-stored-holder-date',
    source: `export function Widget(){const fmt=(x:unknown)=>String(x);const text=(_s:TemplateStringsArray,value:unknown)=>fmt(value);const holder={date:new Date(0)};return <p>{text\`\${holder.date}\`}</p>;}`,
    conversion: undefined,
    dateText: LOCAL_TIME,
    local: LOCAL_TIME,
  },
  {
    id: 'values-map-String-callback-const-date',
    source: `export function Widget(){const text=(_s:TemplateStringsArray,...values:unknown[])=>values.map(String).join("");const date=new Date(0);return <p>{text\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'factory-produced-custom-coercing-tag-stored-holder-date',
    source: `export function Widget(){function makeText(conv:(x:unknown)=>string){return (_s:TemplateStringsArray,v:unknown)=>conv(v);}const text=makeText(String);const holder={date:new Date(0)};return <p>{text\`\${holder.date}\`}</p>;}`,
    conversion: undefined,
    dateText: LOCAL_TIME,
    local: LOCAL_TIME,
  },
  {
    id: 'wrapper-capturing-outer-const-container-String-raw-stored-date',
    source: `export function Widget(){const tags={raw:String.raw};const wrap=(_s:TemplateStringsArray,d:unknown)=>tags.raw\`\${d}\`;const holder={date:new Date(0)};return <p>{wrap\`\${holder.date}\`}</p>;}`,
    conversion: undefined,
    dateText: LOCAL_TIME,
    local: LOCAL_TIME,
  },
  {
    id: 'imported-tag-identifier-retains-direct-date-diagnostic',
    source: `import { text } from "./custom-tag";export function Widget(){const date=new Date(0);return <p>{text\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'epoch-getTime-wrapped-in-String-pin',
    source: `export function Widget(){const epoch=(_s:TemplateStringsArray,d:Date)=>String(d.getTime());const date=new Date(0);return <p>{epoch\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: undefined,
  },
  {
    id: 'toISOString-method-stored-holder-date-pin',
    source: `export function Widget(){const iso=(_s:TemplateStringsArray,d:Date)=>d.toISOString();const holder={date:new Date(0)};return <p>{iso\`\${holder.date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: undefined,
  },
  {
    id: 'toUTCString-method-const-date-pin',
    source: `export function Widget(){const utc=(_s:TemplateStringsArray,d:Date)=>d.toUTCString();const date=new Date(0);return <p>{utc\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: undefined,
  },
  {
    id: 'unary-plus-epoch-coercion-pin',
    source: `export function Widget(){const num=(_s:TemplateStringsArray,d:Date)=>String(+d);const date=new Date(0);return <p>{num\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: undefined,
  },
  {
    id: 'parameter-member-sql-query-tag-pin',
    source: `export function Widget({sql}:{sql:{query:(s:TemplateStringsArray,d:Date)=>string}}){const now=new Date(0);return <p>{sql.query\`SELECT \${now}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: undefined,
  },
  {
    id: 'first-span-coerced-while-date-span-uses-toISOString-pin',
    source: `export function Widget(){const fmt=(_s:TemplateStringsArray,label:unknown,d:Date)=>\`\${label}:\${d.toISOString()}\`;const holder={date:new Date(0)};return <p>{fmt\`\${"at"}\${holder.date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: undefined,
  },
  {
    id: 'shadowed-String-helper-returning-fixed-text-pin',
    source: `export function Widget(){const String=(_v:unknown)=>"fixed";const text=(_s:TemplateStringsArray,v:unknown)=>String(v);const date=new Date(0);return <p>{text\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: undefined,
  },
  {
    id: 'mutated-outer-container-before-wrapper-stored-date-pin',
    source: `export function Widget(){const tags:{raw:(s:TemplateStringsArray,v:unknown)=>string}={raw:String.raw};tags.raw=()=>"fixed";const wrap=(_s:TemplateStringsArray,d:unknown)=>tags.raw\`\${d}\`;const holder={date:new Date(0)};return <p>{wrap\`\${holder.date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: undefined,
  },
  {
    id: 'self-reassigned-array-slice-copy-joining-date',
    source: `export function Widget(){const fmt=(_s:TemplateStringsArray,d:Date)=>{let values=[d];values=values.slice();return values.join("");};const date=new Date(0);return <p>{fmt\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'self-reassigned-borrowed-Array-prototype-slice-call-joining-date',
    source: `export function Widget(){const fmt=(_s:TemplateStringsArray,d:Date)=>{let values=[d];values=Array.prototype.slice.call(values);return values.join("");};const date=new Date(0);return <p>{fmt\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'self-reassigned-array-slice-on-plain-span-while-date-uses-ISO-pin',
    source: `export function Widget(){const fmt=(_s:TemplateStringsArray,label:string,d:Date)=>{let values=[label];values=values.slice();return \`\${values.join("")}:\${d.toISOString()}\`;};const date=new Date(0);return <p>{fmt\`\${"at"}\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: undefined,
  },
] as const;

describe('custom text-coercing template tags and outer-owned raw containers', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ source, conversion, dateText, local }) => {
    expect({
      conversion: firstReaderInput(api, source, renderDateConversion),
      dateText: firstReaderInput(api, source, renderDateText),
      local: firstReaderInput(api, source, renderLocalInput),
    }).toStrictEqual({ conversion, dateText, local });
  });
});

function firstReaderInput(
  api: API,
  source: string,
  reader: (node: Node) => string | undefined,
): string | undefined {
  using parsed = parseModule(api, 'render-custom-coercing-date-tags.tsx', source);
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
