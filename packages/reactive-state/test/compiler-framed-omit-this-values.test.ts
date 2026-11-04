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
    id: 'reported-native-error',
    source:
      'type Selected=OmitThisParameter<Error>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'error-alias',
    source:
      'type Failure=Error;type Selected=OmitThisParameter<Failure>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'whole-generic-alias',
    source:
      'type Hold<T>=OmitThisParameter<T>;type Selected=Hold<Error>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'error-intersection',
    source:
      'type Selected=OmitThisParameter<Error&{tag:string}>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames(Object.assign(new Error("ours"),{tag:"fixed"}))',
    refused: true,
  },
  {
    id: 'object-selected-field',
    source:
      'type Selected=OmitThisParameter<{failure:Error}>;function frames(value:Selected){return value.failure.stack;}',
    invocation: 'frames({failure:new Error("ours")})',
    refused: true,
  },
  {
    id: 'tuple-selected-field',
    source:
      'type Selected=OmitThisParameter<readonly[Error]>;function frames(value:Selected){return value[0].stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'array-selected-field',
    source:
      'type Selected=OmitThisParameter<Error[]>;function frames(value:Selected){return value[0]!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'readonly-error',
    source:
      'type Selected=OmitThisParameter<Readonly<Error>>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'selected-nested-error',
    source:
      'type Selected=OmitThisParameter<Pick<{failure:Error},"failure">>;function frames(value:Selected){return value.failure.stack;}',
    invocation: 'frames({failure:new Error("ours")})',
    refused: true,
  },
  {
    id: 'union-retains-error',
    source:
      'type Selected=OmitThisParameter<Error|{stack:string}>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-repeated-utility',
    source:
      'type Selected=OmitThisParameter<OmitThisParameter<Error>>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'local-subclass',
    source:
      'class Failure extends Error{}type Selected=OmitThisParameter<Failure>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames(new Failure("ours"))',
    refused: true,
  },
  {
    id: 'plain-stack-data',
    source:
      'type Selected=OmitThisParameter<{stack:string}>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'plain-nested-data',
    source:
      'type Selected=OmitThisParameter<{failure:{stack:string}}>;function frames(value:Selected){return value.failure.stack;}',
    invocation: 'frames({failure:{stack:"fixed"}})',
    refused: false,
  },
  {
    id: 'plain-tuple-data',
    source:
      'type Selected=OmitThisParameter<readonly[{stack:string}]>;function frames(value:Selected){return value[0].stack;}',
    invocation: 'frames([{stack:"fixed"}])',
    refused: false,
  },
  {
    id: 'written-error-type-shadow',
    source:
      'type Error={stack:string};type Selected=OmitThisParameter<Error>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'utility-type-shadow',
    source:
      'type OmitThisParameter<T>={stack:string};type Selected=OmitThisParameter<Error>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'receiver-erased-result-pin',
    source:
      'type Selected=ReturnType<OmitThisParameter<(this:{tag:string})=>Error>>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'receiver-erased-data-pin',
    source:
      'type Selected=ReturnType<OmitThisParameter<(this:{tag:string})=>{stack:string}>>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'generic-receiver-result-pin',
    source:
      'type Selected=ReturnType<OmitThisParameter<<T>(this:object)=>Error>>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'plain-selected-string-data',
    source:
      'type Selected=Pick<Error,"stack">;function frames(value:Selected){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'omitted-selected-string-data',
    source:
      'type Selected=OmitThisParameter<Pick<Error,"stack">>;function frames(value:Selected){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
];

describe('noncallable omitted receiver receiver readers', () => {
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

describe('shared noncallable omitted receiver receiver admissions', () => {
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
