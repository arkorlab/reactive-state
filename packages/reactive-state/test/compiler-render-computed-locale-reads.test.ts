import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { renderLocalInput } from '../src/compiler/render-local-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const LOCALE_STRING = 'reads `toLocaleString`, of the time zone or the locale where it runs';

/** Computed member accesses retain resolved constant and union locale method names unless own. */
const CASES = [
  {
    id: 'const-key-number-toLocaleString',
    source:
      'export function Widget(){const key="toLocaleString";return <p>{String((1234.5)[key]())}</p>;}',
    input: LOCALE_STRING,
  },
  {
    id: 'const-alias-chain-localeCompare',
    source:
      'export function Widget(){const first="localeCompare";const key=first;return <p>{String("a"[key]("b"))}</p>;}',
    input: 'reads `localeCompare`, of the time zone or the locale where it runs',
  },
  {
    id: 'const-key-toLocaleLowerCase',
    source: 'export function Widget(){const key="toLocaleLowerCase";return <p>{"I"[key]()}</p>;}',
    input: 'reads `toLocaleLowerCase`, of the time zone or the locale where it runs',
  },
  {
    id: 'const-key-toLocaleUpperCase',
    source: 'export function Widget(){const key="toLocaleUpperCase";return <p>{"i"[key]()}</p>;}',
    input: 'reads `toLocaleUpperCase`, of the time zone or the locale where it runs',
  },
  {
    id: 'for-of-literal-keys-toLocaleString',
    source:
      'export function Widget(){let out="";for(const key of ["toLocaleString","toString"] as const){out+=String((1234.5)[key]());}return <p>{out}</p>;}',
    input: LOCALE_STRING,
  },
  {
    id: 'conditional-key-toLocaleString-or-toString',
    source:
      'export function Widget({flag}:{flag:boolean}){return <p>{String((1234.5)[flag?"toLocaleString":"toString"]())}</p>;}',
    input: LOCALE_STRING,
  },
  {
    id: 'union-typed-parameter-key',
    source:
      'export function Widget(key:"toLocaleString"|"toString"){return <p>{String((1234.5)[key]())}</p>;}',
    input: LOCALE_STRING,
  },
  {
    id: 'const-key-own-object-locale-method',
    source:
      'export function Widget(){const key="toLocaleString";const value={toLocaleString:()=>"fixed"};return <p>{value[key]()}</p>;}',
    input: undefined,
  },
  {
    id: 'const-key-own-date-locale-data',
    source:
      'export function Widget(){const key="toLocaleString";const date=new Date(0);date.toLocaleString=()=>"fixed";return <p>{date[key]()}</p>;}',
    input: undefined,
  },
  {
    id: 'conditional-key-both-own-object-methods',
    source:
      'export function Widget(flag:boolean){const value={toLocaleString:()=>"fixed",toString:()=>"plain"};return <p>{value[flag?"toLocaleString":"toString"]()}</p>;}',
    input: undefined,
  },
  {
    id: 'const-key-write-only-assignment',
    source:
      'export function Widget(){const key="toLocaleString";const box:Record<string,unknown>={};box[key]=()=>"fixed";return <p>{"ok"}</p>;}',
    input: undefined,
  },
  {
    id: 'date-toString-write-only-assignment',
    source:
      'export function Widget(){const date=new Date(0);date.toString=()=>"fixed";return <p>{date.toISOString()}</p>;}',
    input: undefined,
  },
  {
    id: 'unresolved-string-parameter-index',
    source:
      'export function Widget({items,key}:{items:Record<string,string>;key:string}){return <p>{items[key]}</p>;}',
    input: undefined,
  },
  {
    id: 'literal-bracket-toLocaleString-pin',
    source: 'export function Widget(){return <p>{String((1234.5)["toLocaleString"]())}</p>;}',
    input: LOCALE_STRING,
  },
] as const;

describe('computed locale member render inputs', () => {
  it.each(CASES)('$id', ({ source, input }) => {
    expect(firstLocalInput(source)).toBe(input);
  });
});

function firstLocalInput(source: string): string | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'render-computed-locale-reads.tsx', source);
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
