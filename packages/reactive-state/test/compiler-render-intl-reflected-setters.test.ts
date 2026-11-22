import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { renderIntlInput } from '../src/compiler/render-intl-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Setter-only own properties shadow prototype formatter getters, while sibling getters still run on receiver. */
const CASES = [
  {
    id: 'proto-number-format-setter-only-literal',
    source:
      'export function Widget(){return <p>{String(Reflect.get({__proto__:Intl.NumberFormat.prototype,set format(_value:unknown){}},"format",new Intl.NumberFormat()))}</p>;}',
    input: undefined,
  },
  {
    id: 'proto-date-format-computed-string-setter-only',
    source:
      'export function Widget(){return <p>{String(Reflect.get({__proto__:Intl.DateTimeFormat.prototype,set ["format"](_value:unknown){}},"format",new Intl.DateTimeFormat()))}</p>;}',
    input: undefined,
  },
  {
    id: 'proto-collator-const-key-setter-only',
    source:
      'export function Widget(){const key="compare";return <p>{String(Reflect.get({__proto__:Intl.Collator.prototype,set [key](_value:unknown){}},key,new Intl.Collator()))}</p>;}',
    input: undefined,
  },
  {
    id: 'const-target-proto-setter-only',
    source:
      'export function Widget(){const target={__proto__:Intl.NumberFormat.prototype,set format(_value:unknown){}};return <p>{String(Reflect.get(target,"format",new Intl.NumberFormat()))}</p>;}',
    input: undefined,
  },
  {
    id: 'setter-before-proto-still-shadows-inherited-getter',
    source:
      'export function Widget(){return <p>{String(Reflect.get({set format(_value:unknown){},__proto__:Intl.DateTimeFormat.prototype},"format",new Intl.DateTimeFormat("en-US")))}</p>;}',
    input: undefined,
  },
  {
    id: 'conditional-setter-only-and-own-data-targets',
    source:
      'export function Widget({flag}:{flag:boolean}){const target=flag?{__proto__:Intl.NumberFormat.prototype,set format(_value:unknown){}}:{__proto__:Intl.NumberFormat.prototype,format:()=>"fixed"};return <p>{String(Reflect.get(target,"format",new Intl.NumberFormat()))}</p>;}',
    input: undefined,
  },
  {
    id: 'nested-proto-chain-shadowed-by-setter-only',
    source:
      'export function Widget(){return <p>{String(Reflect.get({__proto__:{__proto__:Intl.NumberFormat.prototype,set format(_value:unknown){}}},"format",new Intl.NumberFormat()))}</p>;}',
    input: undefined,
  },
  {
    id: 'getter-before-setter-preserves-own-getter-receiver',
    source:
      'export function Widget(){return <p>{String(Reflect.get({__proto__:Intl.NumberFormat.prototype,get format(){return(_value:number)=>"ok";},set format(_value:unknown){}},"format",new Intl.NumberFormat())(1234.5))}</p>;}',
    input: 'Intl.NumberFormat.locale',
  },
  {
    id: 'setter-before-getter-preserves-own-getter-receiver',
    source:
      'export function Widget(){return <p>{String(Reflect.get({__proto__:Intl.DateTimeFormat.prototype,set format(_value:unknown){},get format(){return(_value:number)=>"ok";}},"format",new Intl.DateTimeFormat())(0))}</p>;}',
    input: 'Intl.DateTimeFormat.locale',
  },
  {
    id: 'getter-overwritten-by-data-then-setter-shadows-receiver',
    source:
      'export function Widget(){return <p>{String(Reflect.get({__proto__:Intl.NumberFormat.prototype,get format(){return(_value:number)=>"ok";},format:()=>"fixed",set format(_value:unknown){}},"format",new Intl.NumberFormat()))}</p>;}',
    input: undefined,
  },
  {
    id: 'unrelated-setter-still-delegates-to-proto-getter',
    source:
      'export function Widget(){return <p>{Reflect.get({__proto__:Intl.NumberFormat.prototype,set other(_value:unknown){}},"format",new Intl.NumberFormat())(1234.5)}</p>;}',
    input: 'Intl.NumberFormat.locale',
  },
  {
    id: 'unknown-computed-setter-conservatively-delegates-to-proto',
    source:
      'export function Widget({name}:{name:string}){return <p>{String(Reflect.get({__proto__:Intl.Collator.prototype,set [name](_value:unknown){}},"compare",new Intl.Collator()))}</p>;}',
    input: 'Intl.Collator.locale',
  },
] as const;

describe('reflected intl formatter setter-only target shadowing', () => {
  it.each(CASES)('$id', ({ source, input }) => {
    expect(firstIntlInput(source)).toBe(input);
  });
});

function firstIntlInput(source: string): string | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'render-intl-reflected-setters.tsx', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    const found = renderIntlInput(node);
    if (found !== undefined) return found;
    const children: Node[] = [];
    node.forEachChild((child) => {
      children.push(child);
    });
    pending.push(...children.toReversed());
  }
  return undefined;
}
