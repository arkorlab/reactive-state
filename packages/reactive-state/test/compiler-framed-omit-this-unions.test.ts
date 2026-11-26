import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Union-wide unknown receiver guards retain the original native operand before erasure. */
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
    id: 'reported-union-wide-unknown',
    source:
      'type Input=(Error&((this:void)=>void))|{stack:string};type Selected=OmitThisParameter<Input>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames(new Error("ours") as Input)',
    refused: true,
  },
  {
    id: 'swapped-noncallable-arm',
    source:
      'type Input={stack:string}|(Error&((this:void)=>void));type Selected=OmitThisParameter<Input>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames(new Error("ours") as Input)',
    refused: true,
  },
  {
    id: 'aliased-callable-union',
    source:
      'type CallableFailure=Error&((this:void)=>void);type Input=CallableFailure|{stack:string};type Selected=OmitThisParameter<Input>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames(new Error("ours") as Input)',
    refused: true,
  },
  {
    id: 'generic-whole-utility-alias',
    source:
      'type Strip<T>=OmitThisParameter<T>;type Input=(Error&((this:void)=>void))|{stack:string};type Selected=Strip<Input>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames(new Error("ours") as Input)',
    refused: true,
  },
  {
    id: 'subclass-callable-union',
    source:
      'class Failure extends Error{}type Input=(Failure&((this:void)=>void))|{stack:string};type Selected=OmitThisParameter<Input>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames(new Failure("ours") as Input)',
    refused: true,
  },
  {
    id: 'nested-member-union',
    source:
      'type Input=({failure:Error}&((this:void)=>void))|{failure:{stack:string}};type Selected=OmitThisParameter<Input>;function frames(value:Selected){return value.failure.stack;}',
    invocation: 'frames({failure:new Error("ours")} as Input)',
    refused: true,
  },
  {
    id: 'literal-data-union-arm',
    source:
      'type Input=(Error&((this:void)=>void))|{stack:"fixed"};type Selected=OmitThisParameter<Input>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames(new Error("ours") as Input)',
    refused: true,
  },
  {
    id: 'receiver-free-callable-arm',
    source:
      'type Input=(Error&((this:void)=>void))|((()=>void)&{stack:string});type Selected=OmitThisParameter<Input>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames(new Error("ours") as Input)',
    refused: true,
  },
  {
    id: 'unknown-receiver-callable-arm',
    source:
      'type Input=(Error&((this:void)=>void))|(((this:unknown)=>void)&{stack:string});type Selected=OmitThisParameter<Input>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames(new Error("ours") as Input)',
    refused: true,
  },
  {
    id: 'any-receiver-callable-arm',
    source:
      'type Input=(Error&((this:void)=>void))|(((this:any)=>void)&{stack:string});type Selected=OmitThisParameter<Input>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames(new Error("ours") as Input)',
    refused: true,
  },
  {
    id: 'last-overload-known-receiver',
    source:
      'type Input=(Error&((this:object)=>void)&((this:void)=>void))|{stack:string};type Selected=OmitThisParameter<Input>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames(new Error("ours") as Input)',
    refused: true,
  },
  {
    id: 'call-interface-union-arm',
    source:
      'interface Call{(this:void):void;}type Input=(Error&Call)|{stack:string};type Selected=OmitThisParameter<Input>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames(new Error("ours") as Input)',
    refused: true,
  },
  {
    id: 'plain-data-union-pin',
    source:
      'type Input={stack:string}|{stack:"fixed"};type Selected=OmitThisParameter<Input>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'callable-data-union-pin',
    source:
      'type Input=({stack:string}&((this:void)=>void))|{stack:string;tag:string};type Selected=OmitThisParameter<Input>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames({stack:"fixed",tag:"yes"})',
    refused: false,
  },
  {
    id: 'all-known-receiver-error-result',
    source:
      'type Input=((this:void)=>Error)|((this:object)=>{stack:string});type Selected=ReturnType<OmitThisParameter<Input>>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'all-known-receiver-data-result',
    source:
      'type Input=((this:void)=>{stack:string})|((this:object)=>{stack:string});type Selected=ReturnType<OmitThisParameter<Input>>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'locally-shadowed-utility-pin',
    source:
      'type OmitThisParameter<T>={stack:string};type Input=(Error&((this:void)=>void))|{stack:string};type Selected=OmitThisParameter<Input>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'noncallable-error-arm-pin',
    source:
      'type Input=Error|{stack:string};type Selected=OmitThisParameter<Input>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames(new Error("ours") as Input)',
    refused: true,
  },
];

describe('union-wide omitted receiver receiver readers', () => {
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

describe('shared union-wide omitted receiver receiver admissions', () => {
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
