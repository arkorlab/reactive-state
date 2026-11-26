import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Receiver intersections preserve the native whole-receiver any guard before omission. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-any-empty-record-receiver',
    source:
      'type Source=Error&((this:any&{})=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.setPrototypeOf(()=>{},new Error("ours")))',
    refused: true,
  },
  {
    id: 'reversed-empty-record-any-receiver',
    source:
      'type Source=Error&((this:{}&any)=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.setPrototypeOf(()=>{},new Error("ours")))',
    refused: true,
  },
  {
    id: 'any-unknown-receiver',
    source:
      'type Source=Error&((this:any&unknown)=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.setPrototypeOf(()=>{},new Error("ours")))',
    refused: true,
  },
  {
    id: 'unknown-any-empty-record-receiver',
    source:
      'type Source=Error&((this:unknown&any&{})=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.setPrototypeOf(()=>{},new Error("ours")))',
    refused: true,
  },
  {
    id: 'any-written-record-receiver',
    source:
      'type Source=Error&((this:any&{id:number})=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.setPrototypeOf(()=>{},new Error("ours")))',
    refused: true,
  },
  {
    id: 'any-native-number-receiver',
    source:
      'type Source=Error&((this:any&number)=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.setPrototypeOf(()=>{},new Error("ours")))',
    refused: true,
  },
  {
    id: 'explicit-never-dominates-any',
    source:
      'type Source=Error&((this:any&never)=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.assign(()=>{},{stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'reversed-never-dominates-any',
    source:
      'type Source=Error&((this:never&any)=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.assign(()=>{},{stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'nested-explicit-never-dominates-any',
    source:
      'type Source=Error&((this:(any&{})&never)=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.assign(()=>{},{stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'union-never-is-not-intersection-never',
    source:
      'type Source=Error&((this:any&(never|{}))=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.setPrototypeOf(()=>{},new Error("ours")))',
    refused: true,
  },
  {
    id: 'union-any-remains-unknown-receiver',
    source:
      'type Source=Error&((this:(any|never)&{})=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.setPrototypeOf(()=>{},new Error("ours")))',
    refused: true,
  },
  {
    id: 'any-primitive-union-receiver',
    source:
      'type Source=Error&((this:any&(number|string))=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.setPrototypeOf(()=>{},new Error("ours")))',
    refused: true,
  },
  {
    id: 'disjoint-primitive-receiver-before-any',
    source:
      'type Source=Error&((this:any&string&number)=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.assign(()=>{},{stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'disjoint-literal-receiver-before-any',
    source:
      'type Source=Error&((this:any&"left"&"right")=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.assign(()=>{},{stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'unknown-empty-record-is-known',
    source:
      'type Source=Error&((this:unknown&{})=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.assign(()=>{},{stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'only-unknown-intersection-keeps-source',
    source:
      'type Source=Error&((this:unknown&unknown)=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.setPrototypeOf(()=>{},new Error("ours")))',
    refused: true,
  },
  {
    id: 'whole-any-receiver-alias',
    source:
      'type Receiver=any&{};type Source=Error&((this:Receiver)=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.setPrototypeOf(()=>{},new Error("ours")))',
    refused: true,
  },
  {
    id: 'generic-actual-any-receiver',
    source:
      'type Receiver<T>=T&{};type Source=Error&((this:Receiver<any>)=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.setPrototypeOf(()=>{},new Error("ours")))',
    refused: true,
  },
  {
    id: 'generic-actual-never-receiver',
    source:
      'type Receiver<T>=T&{};type Source=Error&((this:Receiver<never>)=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.assign(()=>{},{stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'aliased-never-dominates-any',
    source:
      'type Empty=never;type Source=Error&((this:any&Empty)=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.assign(()=>{},{stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'last-overload-any-keeps-source',
    source:
      'type Source=Error&{(this:{}):void;(this:any&{}):void};type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.setPrototypeOf(()=>{},new Error("ours")))',
    refused: true,
  },
  {
    id: 'last-overload-known-erases-source',
    source:
      'type Source=Error&{(this:any&{}):void;(this:{}):void};type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.assign(()=>{},{stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'union-wide-any-intersection-keeps-error',
    source:
      'type Source=(Error&((this:{})=>void))|((this:any&{})=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.setPrototypeOf(()=>{},new Error("ours")))',
    refused: true,
  },
  {
    id: 'known-union-receivers-remain-erased',
    source:
      'type Source=(Error&((this:unknown&{})=>void))|((this:any&never)=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.assign(()=>{},{stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'any-intersection-ordinary-data-remains-data',
    source:
      'type Source={stack:string}&((this:any&{})=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.assign(()=>{},{stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'existing-whole-any-receiver',
    source:
      'type Source=Error&((this:any)=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.setPrototypeOf(()=>{},new Error("ours")))',
    refused: true,
  },
  {
    id: 'existing-whole-unknown-receiver',
    source:
      'type Source=Error&((this:unknown)=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.setPrototypeOf(()=>{},new Error("ours")))',
    refused: true,
  },
  {
    id: 'existing-known-record-receiver',
    source:
      'type Source=Error&((this:{})=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.assign(()=>{},{stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'unknown-primitive-union-is-known',
    source:
      'type Source=Error&((this:unknown&(string|number))=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.assign(()=>{},{stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'reversed-generic-actual-any-receiver',
    source:
      'type Receiver<T>={}&T;type Source=Error&((this:Receiver<any>)=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.setPrototypeOf(()=>{},new Error("ours")))',
    refused: true,
  },
  {
    id: 'any-nullish-known-record-remains-never',
    source:
      'type Source=Error&((this:any&null&{})=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.assign(()=>{},{stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'any-nullish-native-error-remains-never',
    source:
      'type Source=Error&((this:any&null&Error)=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.assign(()=>{},{stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'any-nullish-written-interface-remains-never',
    source:
      'interface Holder{id:number}type Source=Error&((this:any&null&Holder)=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.assign(()=>{},{stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'any-object-string-remains-never',
    source:
      'type Source=Error&((this:any&object&string)=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.assign(()=>{},{stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'root-mixed-error-number-nullish-receiver',
    source:
      'type Source=Error&((this:any&null&(Error|number))=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.setPrototypeOf(()=>{},new Error("ours")))',
    refused: true,
  },
  {
    id: 'root-mixed-interface-string-undefined-receiver',
    source:
      'interface Holder{id:number}type Source=Error&((this:any&undefined&(Holder|string))=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.setPrototypeOf(()=>{},new Error("ours")))',
    refused: true,
  },
  {
    id: 'root-all-object-union-nullish-receiver',
    source:
      'interface Holder{id:number}type Source=Error&((this:any&null&(Error|Holder))=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.setPrototypeOf(()=>{},new Error("ours")))',
    refused: true,
  },
  {
    id: 'duplicate-error-union-retains-single-never-intersection',
    source:
      'type Source=Error&((this:any&null&(Error|Error))=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.assign(()=>{},{stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'aliased-duplicate-error-union-retains-native-erasure',
    source:
      'type Alias=Error;type Source=Error&((this:any&null&(Error|Alias))=>void);type Omitted=OmitThisParameter<Source>;type Failure=Omitted&{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(Object.assign(()=>{},{stack:"fixed"}))',
    refused: false,
  },
];

describe('omitted intersection receiver readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'omitted-intersection-receivers.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(refused);
  });
});

describe('shared omitted intersection receiver admissions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
