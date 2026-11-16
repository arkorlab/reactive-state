import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { renderLocalInput } from '../src/compiler/render-local-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DATE_TEXT = 'writes a date as text of the time zone where it runs';

/** Bound native String.raw tags retain Date text inputs while overridden object tag entries do not. */
const CASES = [
  {
    id: 'bound-String-raw-const-date',
    source: `export function Widget(){const raw=String.raw.bind(null);const date=new Date(0);return <p>{raw\`\${date}\`}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'inline-bound-String-raw-zero-args',
    source: `export function Widget(){return <p>{String.raw.bind()\`\${new Date(0)}\`}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'chained-bound-String-raw-typed-date',
    source: `export function Widget(date:Date){const raw=String.raw.bind(null).bind(undefined);return <p>{raw\`\${date}\`}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'aliased-String-raw-bound-chain',
    source: `export function Widget(){const r=String.raw;const first=r.bind(null);const raw=first.bind(null);const date=new Date(0);return <p>{raw\`\${date}\`}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'computed-String-raw-bound-tag',
    source: `export function Widget(){const key="raw";const raw=String[key].bind(null);const date=new Date(0);return <p>{raw\`\${date}\`}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'Function-prototype-bind-call-String-raw',
    source: `export function Widget(){const raw=Function.prototype.bind.call(String.raw,null);const date=new Date(0);return <p>{raw\`\${date}\`}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'Function-prototype-bind-apply-String-raw',
    source: `export function Widget(){const raw=Function.prototype.bind.apply(String.raw,[null]);const date=new Date(0);return <p>{raw\`\${date}\`}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'Reflect-apply-Function-prototype-bind-String-raw',
    source: `export function Widget(){const raw=Reflect.apply(Function.prototype.bind,String.raw,[null]);const date=new Date(0);return <p>{raw\`\${date}\`}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'destructured-bind-call-String-raw',
    source: `export function Widget(){const {bind}=Function.prototype;const raw=bind.call(String.raw,null);const date=new Date(0);return <p>{raw\`\${date}\`}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'spread-String-raw-overridden-by-own-custom-tag',
    source: `export function Widget(){const tags={...{raw:String.raw},raw:(_s:TemplateStringsArray,d:Date)=>d.toISOString()};const date=new Date(0);return <p>{tags.raw\`\${date}\`}</p>;}`,
    local: undefined,
  },
  {
    id: 'spread-String-raw-overridden-by-computed-const-key',
    source: `export function Widget(){const key="raw";const base={raw:String.raw};const tags={...base,[key]:(_s:TemplateStringsArray,d:Date)=>String(d.getTime())};const date=new Date(0);return <p>{tags[key]\`\${date}\`}</p>;}`,
    local: undefined,
  },
  {
    id: 'custom-tag-bound-pin',
    source: `export function Widget(){const custom=(_s:TemplateStringsArray,d:Date)=>d.toISOString();const raw=custom.bind(null);const date=new Date(0);return <p>{raw\`\${date}\`}</p>;}`,
    local: undefined,
  },
  {
    id: 'Function-prototype-bind-call-custom-tag-pin',
    source: `export function Widget(){const custom=(_s:TemplateStringsArray,d:Date)=>String(d.getTime());const raw=Function.prototype.bind.call(custom,null);const date=new Date(0);return <p>{raw\`\${date}\`}</p>;}`,
    local: undefined,
  },
  {
    id: 'object-own-bind-method-with-String-raw-arg-pin',
    source: `export function Widget(){const box={bind:(_fn:unknown)=>(_s:TemplateStringsArray,d:Date)=>d.toISOString()};const date=new Date(0);return <p>{box.bind(String.raw)\`\${date}\`}</p>;}`,
    local: undefined,
  },
  {
    id: 'own-custom-tag-overridden-by-later-spread-String-raw-pin',
    source: `export function Widget(){const tags={raw:(_s:TemplateStringsArray,d:Date)=>d.toISOString(),...{raw:String.raw}};const date=new Date(0);return <p>{tags.raw\`\${date}\`}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'conditional-computed-key-does-not-mask-earlier-String-raw-pin',
    source: `export function Widget({flag}:{flag:boolean}){const tags={raw:String.raw,[flag?"raw":"other"]:(_s:TemplateStringsArray,d:Date)=>d.toISOString()};const date=new Date(0);return <p>{tags.raw\`\${date}\`}</p>;}`,
    local: DATE_TEXT,
  },
] as const;

describe('bound String.raw and overridden object-literal date template tags', () => {
  it.each(CASES)('$id', ({ source, local }) => {
    expect(firstLocalInput(source)).toBe(local);
  });
});

function firstLocalInput(source: string): string | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'render-bound-raw-date-tags.tsx', source);
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
