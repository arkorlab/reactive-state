import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Closed generic native receiver erasure retains original selected parameter and result types. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly reader?: boolean;
  readonly files?: Readonly<Record<string, string>>;
}

const CASES: readonly Case[] = [
  {
    id: 'generic-parameter-review',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Failure=Parameters<OmitThisParameter<<T>(this:object,error:Error)=>void>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-parameter-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Failure=Parameters<OmitThisParameter<<T>(this:object,error:Data)=>void>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'generic-result-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Failure=ReturnType<OmitThisParameter<<T>(this:object)=>Error>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-result-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Failure=ReturnType<OmitThisParameter<<T>(this:object)=>Data>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'independent-parameter-dependent-result',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Failure=Parameters<OmitThisParameter<<T>(this:object,error:Error)=>T>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'independent-result-dependent-parameter',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Failure=ReturnType<OmitThisParameter<<T>(this:object,value:T)=>Error>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-constraint-parameter',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Failure=Parameters<OmitThisParameter<<T extends Error>(this:object,value:T)=>T>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-constraint-result',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Failure=ReturnType<OmitThisParameter<<T extends Error>(this:object,value:T)=>T>>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unconstrained-parameters-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Failure=Parameters<OmitThisParameter<<T>(this:object,value:T)=>T>>[0]&Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'default-parameters-is-not-an-actual',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Failure=Parameters<OmitThisParameter<<T=Error>(this:object,value:T)=>T>>[0]&Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unconstrained-returntype-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Failure=ReturnType<OmitThisParameter<<T>(this:object,value:T)=>T>>&Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'default-returntype-is-not-an-actual',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Failure=ReturnType<OmitThisParameter<<T=Error>(this:object,value:T)=>T>>&Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'constraint-before-default',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Failure=Parameters<OmitThisParameter<<T extends Error=FixedError>(this:object,value:T)=>T>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'type-literal-call-signature',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Maker={<T>(this:object,error:Error):void};type Failure=Parameters<OmitThisParameter<Maker>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'interface-call-signature',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker{<T>(this:object,error:Error):void}type Failure=Parameters<OmitThisParameter<Maker>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'original-alias-argument-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Maker<A>=<T>(this:object,error:A)=>void;type Failure=Parameters<OmitThisParameter<Maker<Error>>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'original-alias-argument-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Maker<A>=<T>(this:object,error:A)=>void;type Failure=Parameters<OmitThisParameter<Maker<Data>>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'original-alias-default',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Maker<A=Error>=<T>(this:object,error:A)=>void;type Failure=Parameters<OmitThisParameter<Maker>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'original-interface-argument',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};interface Maker<A>{<T>(this:object,error:A):void}type Failure=Parameters<OmitThisParameter<Maker<Error>>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'last-overload-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Maker={<T>(this:object,error:Data):void;<U>(this:object,error:Error):void};type Failure=Parameters<OmitThisParameter<Maker>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'last-overload-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Maker={<T>(this:object,error:Error):void;<U>(this:object,error:Data):void};type Failure=Parameters<OmitThisParameter<Maker>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'qualified-native-utility',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Failure=Parameters<globalThis.OmitThisParameter<<T>(this:object,error:Error)=>void>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'local-utility-shadow-data-pin',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type OmitThisParameter<T>=(value:Data)=>void;type Failure=Parameters<OmitThisParameter<<T>(this:object,error:Error)=>void>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'nongeneric-error-pin',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Failure=Parameters<OmitThisParameter<(this:object,error:Error)=>void>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'no-explicit-receiver-pin',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Failure=Parameters<OmitThisParameter<<T>(error:Error)=>void>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unknown-receiver-pin',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Failure=Parameters<OmitThisParameter<<T>(this:unknown,error:Error)=>void>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'optional-error-parameter',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Failure=Parameters<OmitThisParameter<<T>(this:object,error?:Error)=>void>>[0];function frames(value:Failure){return value?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'rest-error-parameter',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Failure=Parameters<OmitThisParameter<<T>(this:object,...errors:Error[])=>void>>[number];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'removed-receiver-existing-opacity-pin',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Failure=unknown extends ThisParameterType<OmitThisParameter<<T>(this:object,error:Error)=>void>>?Data:Error;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: true,
  },
  {
    id: 'outer-unbound-parameters-data-pin',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};function frames<U extends Error>(value:Parameters<OmitThisParameter<<T>(this:object,error:U)=>U>>[0]){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'outer-unbound-returntype-data-pin',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};function frames<U extends Error>(value:ReturnType<OmitThisParameter<<T>(this:object,error:U)=>U>>){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'called-original-alias-error',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Maker<A>=OmitThisParameter<<T>(this:object)=>A>;function frames(make:Maker<Error>){return make().stack;}',
    invocation: 'frames(()=>new Error("ours"))',
    refused: true,
  },
  {
    id: 'called-original-alias-data',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Maker<A>=OmitThisParameter<<T>(this:object)=>A>;function frames(make:Maker<Data>){return make().stack;}',
    invocation: 'frames(()=>({stack:"fixed"}))',
    refused: false,
  },
  {
    id: 'unresolved-instantiation-query-data-pin',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};function make<T extends Error>(this:object,error:T):T{return error;}function frames<U extends Error>(value:Parameters<OmitThisParameter<typeof make<U>>>[0]){return value.stack;}',
    invocation: 'frames({name:"Fixed",message:"fixed",stack:"fixed"})',
    refused: false,
  },
  {
    id: 'unknown-interface-heritage-data-pin',
    source:
      'type Data={stack:string};type FixedError={name:"Fixed";message:"fixed";stack:"fixed"};type Base=import("./external.js").Base;interface Maker extends Base{<T>(this:object,error:Error):void}type Failure=Parameters<OmitThisParameter<Maker>>[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
    files: {
      'domain/external.ts': 'export interface Base{(this:object,error:{stack:string}):void}',
    },
  },
];

describe('omitted generic receiver readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'omitted-generic-receivers.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(reader);
  });
});

describe('shared omitted generic receiver admissions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused, files }) => {
    const app = await application({
      ...files,
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
