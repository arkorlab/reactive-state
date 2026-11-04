import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native at selects its consumed index from closed argument tuples. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly reader?: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-closed-tuple',
    source:
      'function frames(error:Error){return [error,{stack:"fixed"}].at(...([1] as const))!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'computed-at-closed-tuple',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];return values["at"](...([1] as const))!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'whole-constant-tuple',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];const indices=[1] as const;return values.at(...indices)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'whole-tuple-alias-chain',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];const indices=[1] as const;const saved=indices;return values.at(...saved)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'closed-nested-spread',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];return values.at(...([...([1] as const)] as const))!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'empty-prefix-before-fixed-index',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];return values.at(...([] as const),...([1] as const))!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'negative-closed-index',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];return values.at(...([-1] as const))!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'fractional-closed-index',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];return values.at(...([1.9] as const))!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'constant-index-in-tuple',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];const index=1;return values.at(...([index] as const))!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'empty-tuple-native-default',
    source:
      'function frames(error:Error){const values=[{stack:"fixed"},error];return (values.at as (index?:number)=>Error|{stack:string}|undefined)(...([] as const))!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'hole-tuple-native-default',
    source:
      'function frames(error:Error){const values=[{stack:"fixed"},error];return (values.at as (index?:number)=>Error|{stack:string}|undefined)(...([,] as const))!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'borrowed-call-closed-index',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];return Array.prototype.at.call(values,...([1] as const))!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'borrowed-call-bypasses-own-at',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];values.at=()=>error;return Array.prototype.at.call(values,...([1] as const))!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'direct-known-data-pin',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];return values.at(1)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'direct-known-error-pin',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];return values.at(0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'negative-error-position-pin',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];return values.at(...([-2] as const))!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unknown-tuple-index-pin',
    source:
      'function frames(error:Error,indices:readonly[number]){const values=[error,{stack:"fixed"}];return values.at(...indices)!.stack;}',
    invocation: 'frames(new Error("ours"),[0])',
    refused: true,
  },
  {
    id: 'exposed-tuple-index-pin',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];const indices:[number]=[1];indices[0]=0;return values.at(...indices)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'side-effect-after-index-pin',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];return values.at(...([1] as const),...((values[1]=error),[] as []))!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-at-error-pin',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];values.at=()=>error;return values.at(...([1] as const))!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-at-data-pin',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];values.at=()=>({stack:"fixed"});return values.at(...([0] as const))!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'borrowed-apply-literal-pin',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];return Array.prototype.at.apply(values,[1])!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'reflected-literal-list-pin',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];return Reflect.apply(Array.prototype.at,values,[1])!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'reflected-spread-opaque-pin',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];return Reflect.apply(Array.prototype.at,values,[...([1] as const)])!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'omitted-argument-default-pin',
    source:
      'function frames(error:Error){const values=[{stack:"fixed"},error];return (values.at as (index?:number)=>Error|{stack:string}|undefined)()!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'out-of-bounds-closed-tuple',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];return values.at(...([3] as const))?.stack??"fixed";}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'local-at-implementation-pin',
    source:
      'function frames(error:Error){const values={at(_index:number){return {stack:"fixed"};}};return values.at(...([1] as const)).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'spread-index-default-source',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];const indices:[number]=[1];const {a=values.at(...indices)!.stack}=(indices[0]=0,{} as {a?:string});return a;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'spread-index-default-source-none',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];const indices:[number]=[1];const {a=values.at(...indices)!.stack}={} as {a?:string};return a;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('closed tuple Array.at mapper readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-array-from-mappers.ts', source);
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

describe('shared closed tuple Array.at mapper admissions', () => {
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
