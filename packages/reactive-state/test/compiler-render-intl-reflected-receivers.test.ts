import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { renderIntlInput } from '../src/compiler/render-intl-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Reflect.get only passes its receiver to native formatter getter accessors not shadowed by own data. */
const CASES = [
  {
    id: 'own-object-literal-format-with-default-date-receiver',
    source:
      'export function Widget(){return <p>{Reflect.get({format:()=>"fixed"},"format",new Intl.DateTimeFormat())()}</p>;}',
    input: undefined,
  },
  {
    id: 'own-method-shorthand-compare-with-default-collator-receiver',
    source:
      'export function Widget(){return <p>{String(Reflect.get({compare(){return 0;}},"compare",new Intl.Collator())())}</p>;}',
    input: undefined,
  },
  {
    id: 'const-object-target-format-with-default-number-receiver',
    source:
      'export function Widget(){const target={format:(_value:number)=>"fixed"};return <p>{Reflect.get(target,"format",new Intl.NumberFormat())(1234.5)}</p>;}',
    input: undefined,
  },
  {
    id: 'own-parameter-data-property-with-default-receiver',
    source:
      'export function Widget({format}:{format:()=>string}){const target={format};return <p>{Reflect.get(target,"format",new Intl.DateTimeFormat())()}</p>;}',
    input: undefined,
  },
  {
    id: 'empty-object-target-without-accessor',
    source:
      'export function Widget(){return <p>{String(Reflect.get({},"format",new Intl.NumberFormat()))}</p>;}',
    input: undefined,
  },
  {
    id: 'proto-object-shadowed-by-own-format',
    source:
      'export function Widget(){return <p>{Reflect.get({__proto__:Intl.NumberFormat.prototype,format:()=>"fixed"},"format",new Intl.NumberFormat())()}</p>;}',
    input: undefined,
  },
  {
    id: 'ordinary-method-formatToParts-ignores-receiver',
    source:
      'export function Widget(){const fixed=new Intl.DateTimeFormat("en-US",{timeZone:"UTC"});return <p>{String(Reflect.get(fixed,"formatToParts",new Intl.DateTimeFormat()).call(fixed,0).length)}</p>;}',
    input: undefined,
  },
  {
    id: 'prototype-resolvedOptions-ignores-receiver',
    source:
      'export function Widget(){const fixed=new Intl.NumberFormat("en-US");return <p>{Reflect.get(Intl.NumberFormat.prototype,"resolvedOptions",new Intl.NumberFormat()).call(fixed).locale}</p>;}',
    input: undefined,
  },
  {
    id: 'list-format-ordinary-format-method-ignores-receiver',
    source:
      'export function Widget(){const fixed=new Intl.ListFormat("en-US");return <p>{Reflect.get(fixed,"format",new Intl.ListFormat()).call(fixed,["a","b"])}</p>;}',
    input: undefined,
  },
  {
    id: 'mismatched-list-format-target-with-date-receiver',
    source:
      'export function Widget(){const fixed=new Intl.ListFormat("en-US");return <p>{Reflect.get(fixed,"format",new Intl.DateTimeFormat()).call(fixed,["a","b"])}</p>;}',
    input: undefined,
  },
  {
    id: 'fixed-number-target-with-default-number-receiver',
    source:
      'export function Widget(){return <p>{Reflect.get(new Intl.NumberFormat("en-US"),"format",new Intl.NumberFormat())(1234.5)}</p>;}',
    input: 'Intl.NumberFormat.locale',
  },
  {
    id: 'date-prototype-target-with-default-zone-receiver',
    source:
      'export function Widget(){return <p>{Reflect.get(Intl.DateTimeFormat.prototype,"format",new Intl.DateTimeFormat("en-US"))(0)}</p>;}',
    input: 'Intl.DateTimeFormat.locale',
  },
  {
    id: 'collator-prototype-target-with-default-collator-receiver',
    source:
      'export function Widget(){return <p>{String(Reflect.get(Intl.Collator.prototype,"compare",new Intl.Collator())("a","b"))}</p>;}',
    input: 'Intl.Collator.locale',
  },
  {
    id: 'proto-object-inheriting-number-format-accessor',
    source:
      'export function Widget(){return <p>{Reflect.get({__proto__:Intl.NumberFormat.prototype},"format",new Intl.NumberFormat())(1234.5)}</p>;}',
    input: 'Intl.NumberFormat.locale',
  },
  {
    id: 'unknown-parameter-target-with-default-number-receiver',
    source:
      'export function Widget({target}:{target:Intl.NumberFormat}){return <p>{Reflect.get(target,"format",new Intl.NumberFormat())(1234.5)}</p>;}',
    input: 'Intl.NumberFormat.locale',
  },
  {
    id: 'mutated-object-target-before-reflect-get',
    source:
      'export function Widget(){const target:{format?:unknown}={format:()=>"fixed"};delete target.format;Object.setPrototypeOf(target,Intl.DateTimeFormat.prototype);return <p>{String((Reflect.get(target,"format",new Intl.DateTimeFormat()) as (value:number)=>string)(0))}</p>;}',
    input: 'Intl.DateTimeFormat.locale',
  },
  {
    id: 'fixed-target-and-fixed-receiver',
    source:
      'export function Widget(){const formatter=new Intl.NumberFormat("de-DE");return <p>{Reflect.get(formatter,"format",formatter)(1234.5)}</p>;}',
    input: undefined,
  },
] as const;

describe('reflected intl formatter receiver qualification', () => {
  it.each(CASES)('$id', ({ source, input }) => {
    expect(firstIntlInput(source)).toBe(input);
  });
});

function firstIntlInput(source: string): string | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'render-intl-reflected-receivers.tsx', source);
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
