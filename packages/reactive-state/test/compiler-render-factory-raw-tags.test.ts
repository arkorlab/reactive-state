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

/** Factory-produced and unresolved call-result template tags retain native String.raw Date coercion inputs. */
const CASES = [
  {
    id: 'function-declaration-factory-String-raw-const-date',
    source: `export function Widget(){function makeRaw(){return String.raw;}const raw=makeRaw();const date=new Date(0);return <p>{raw\`\${date}\`}</p>;}`,
    conversion: LOCAL_TIME,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'arrow-factory-String-raw-typed-date-parameter',
    source: `export function Widget(date:Date){const makeRaw=()=>String.raw;const raw=makeRaw();return <p>{raw\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'inline-IIFE-String-raw-direct-new-date',
    source: `export function Widget(){return <p>{(()=>String.raw)()\`\${new Date(0)}\`}</p>;}`,
    conversion: LOCAL_TIME,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'function-factory-String-raw-stored-holder-date',
    source: `export function Widget(){function makeRaw(){return String.raw;}const raw=makeRaw();const holder={date:new Date(0)};return <p>{raw\`\${holder.date}\`}</p>;}`,
    conversion: undefined,
    dateText: LOCAL_TIME,
    local: LOCAL_TIME,
  },
  {
    id: 'arrow-factory-String-raw-date-array-substitution',
    source: `export function Widget(){const makeRaw=()=>String.raw;const raw=makeRaw();const dates=[new Date(0)];return <p>{raw\`\${dates}\`}</p>;}`,
    conversion: LOCAL_TIME,
    dateText: undefined,
    local: undefined,
  },
  {
    id: 'arrow-factory-String-raw-direct-call-date-array',
    source: `export function Widget(){const makeRaw=()=>String.raw;const raw=makeRaw();const dates=[new Date(0)];return <p>{raw({raw:["",""]},dates)}</p>;}`,
    conversion: LOCAL_TIME,
    dateText: undefined,
    local: undefined,
  },
  {
    id: 'object-method-factory-String-raw-stored-holder-date',
    source: `export function Widget(){const kit={makeRaw(){return String.raw;}};const holder={date:new Date(0)};return <p>{kit.makeRaw()\`\${holder.date}\`}</p>;}`,
    conversion: undefined,
    dateText: LOCAL_TIME,
    local: LOCAL_TIME,
  },
  {
    id: 'factory-returning-object-container-String-raw',
    source: `export function Widget(){function makeTags(){return {raw:String.raw};}const holder={date:new Date(0)};return <p>{makeTags().raw\`\${holder.date}\`}</p>;}`,
    conversion: undefined,
    dateText: LOCAL_TIME,
    local: LOCAL_TIME,
  },
  {
    id: 'factory-returning-tuple-destructured-String-raw',
    source: `export function Widget(){const makePair=()=>[String.raw] as const;const [raw]=makePair();const date=new Date(0);return <p>{raw\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'factory-returning-forwarding-wrapper-stored-holder-date',
    source: `export function Widget(){function makeWrapper(){return (s:TemplateStringsArray,...v:unknown[])=>String.raw(s,...v);}const raw=makeWrapper();const holder={date:new Date(0)};return <p>{raw\`\${holder.date}\`}</p>;}`,
    conversion: undefined,
    dateText: LOCAL_TIME,
    local: LOCAL_TIME,
  },
  {
    id: 'parameterized-identity-factory-forwarding-String-raw',
    source: `export function Widget(){const id=<T,>(tag:T):T=>tag;const raw=id(String.raw);const holder={date:new Date(0)};return <p>{raw\`\${holder.date}\`}</p>;}`,
    conversion: undefined,
    dateText: LOCAL_TIME,
    local: LOCAL_TIME,
  },
  {
    id: 'conditional-branch-factory-returning-String-raw-or-custom',
    source: `export function Widget({flag}:{flag:boolean}){const epoch=(_s:TemplateStringsArray,d:Date)=>String(d.getTime());function pickTag(rawMode:boolean){if(rawMode)return String.raw;return epoch;}const raw=pickTag(flag);const date=new Date(0);return <p>{raw\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'Reflect-apply-and-bound-factory-returning-String-raw',
    source: `export function Widget(){function makeRaw(tag:typeof String.raw){return tag;}const boundMake=makeRaw.bind(null,String.raw);const raw=Reflect.apply(boundMake,null,[]);const date=new Date(0);return <p>{raw\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'unresolved-parameter-factory-retains-direct-date-diagnostic',
    source: `export function Widget({makeTag}:{makeTag:()=>(s:TemplateStringsArray,d:Date)=>string}){const raw=makeTag();const date=new Date(0);return <p>{raw\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'unresolved-imported-factory-retains-direct-date-diagnostic',
    source: `import { makeTag } from "./tag-factory";export function Widget(){const raw=makeTag();const date=new Date(0);return <p>{raw\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: DATE_TEXT,
  },
  {
    id: 'function-factory-returning-ISO-custom-tag-pin',
    source: `export function Widget(){function makeSafe(){return (_s:TemplateStringsArray,d:Date)=>d.toISOString();}const tag=makeSafe();const date=new Date(0);return <p>{tag\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: undefined,
  },
  {
    id: 'object-method-factory-returning-epoch-custom-tag-pin',
    source: `export function Widget(){const kit={makeSafe(){return (_s:TemplateStringsArray,d:Date)=>String(d.getTime());}};const holder={date:new Date(0)};return <p>{kit.makeSafe()\`\${holder.date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: undefined,
  },
  {
    id: 'parameterized-identity-factory-with-custom-tag-pin',
    source: `export function Widget(){const id=<T,>(tag:T):T=>tag;const custom=(_s:TemplateStringsArray,d:Date)=>d.toUTCString();const tag=id(custom);const date=new Date(0);return <p>{tag\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: undefined,
  },
  {
    id: 'factory-returning-object-container-with-custom-raw-pin',
    source: `export function Widget(){function makeTags(){return {raw:(_s:TemplateStringsArray,d:Date)=>d.toISOString()};}const date=new Date(0);return <p>{makeTags().raw\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: undefined,
  },
  {
    id: 'factory-returning-shadowed-String-raw-pin',
    source: `export function Widget(){const String={raw:(_s:TemplateStringsArray,..._v:unknown[])=>"fixed"};function makeRaw(){return String.raw;}const raw=makeRaw();const date=new Date(0);return <p>{raw\`\${date}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: undefined,
  },
  {
    id: 'side-effecting-factory-rewriting-Date-prototype-stored-date-pin',
    source: `export function Widget(){function makeRaw(){Date.prototype.toString=()=>"fixed";return String.raw;}const raw=makeRaw();const dates=[new Date(0)];return <p>{raw\`\${dates}\`}</p>;}`,
    conversion: undefined,
    dateText: undefined,
    local: undefined,
  },
] as const;

describe('factory-produced and unresolved call-result raw template tags', () => {
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
  using parsed = parseModule(api, 'render-factory-raw-tags.tsx', source);
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
