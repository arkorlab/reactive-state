import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Mixed Set identities retain possible primitive collisions before selecting an insertion slot. */
const CASES = [
  {
    id: 'reported-number-union',
    source:
      'function frames(value:Error|number,error:Error){return new AggregateError(new Set([value,0,error]),"ours").errors[1].stack;}',
    invocation: 'frames(0,new Error("ours"))',
    refused: true,
  },
  {
    id: 'literal-zero-union',
    source:
      'function frames(value:Error|0,error:Error){return new AggregateError(new Set([value,0,error]),"ours").errors[1].stack;}',
    invocation: 'frames(0,new Error("ours"))',
    refused: true,
  },
  {
    id: 'string-union',
    source:
      'function frames(value:Error|string,error:Error){return new AggregateError(new Set([value,"fixed",error]),"ours").errors[1].stack;}',
    invocation: 'frames("fixed",new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-local-union-alias',
    source:
      'type Mixed<T>=Error|T;function frames(value:Mixed<number>,error:Error){return new AggregateError(new Set([value,0,error]),"ours").errors[1].stack;}',
    invocation: 'frames(0,new Error("ours"))',
    refused: true,
  },
  {
    id: 'whole-value-alias',
    source:
      'function frames(value:Error|number,error:Error){const selected=value;return new AggregateError(new Set([selected,0,error]),"ours").errors[1].stack;}',
    invocation: 'frames(0,new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-add-chain',
    source:
      'function frames(value:Error|number,error:Error){return new AggregateError(new Set<Error|number>([value]).add(0).add(error),"ours").errors[1].stack;}',
    invocation: 'frames(0,new Error("ours"))',
    refused: true,
  },
  {
    id: 'Error-only-remains-distinct-from-primitive',
    source:
      'function frames(value:Error,error:Error){return new AggregateError(new Set([value,0,error]),"ours").errors[1]?.stack??"fixed";}',
    invocation: 'frames(new Error("first"),new Error("ours"))',
    refused: false,
  },
  {
    id: 'Error-only-alias-remains-distinct',
    source:
      'type Failure=Error;function frames(value:Failure,error:Error){return new AggregateError(new Set([value,0,error]),"ours").errors[1]?.stack??"fixed";}',
    invocation: 'frames(new Error("first"),new Error("ours"))',
    refused: false,
  },
  {
    id: 'fresh-data-remains-distinct',
    source:
      'function frames(value:Error|number,error:Error){return new AggregateError(new Set([value,{stack:"fixed"},error]),"ours").errors[1].stack;}',
    invocation: 'frames(0,new Error("ours"))',
    refused: false,
  },
  {
    id: 'guaranteed-primitive-duplicate-existing-origin',
    source:
      'function frames(error:Error){return new AggregateError(new Set([0,0,error]),"ours").errors[1].stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'own-iterator-remains-opaque',
    source:
      'function frames(value:Error|number,error:Error){const values=new Set([value,0,error]);values[Symbol.iterator]=function*(){yield {stack:"fixed"}as never;};return new AggregateError(values,"ours").errors[0].stack;}',
    invocation: 'frames(0,new Error("ours"))',
    refused: false,
  },
  {
    id: 'ignored-options-getter-effect-keeps-boundary',
    source:
      'function frames(value:Error|number,error:Error){return new AggregateError(new Set([value,0,error]),"ours",{get cause(){Object.assign(error,{stack:"fixed"});return 0;}}).errors[1].stack;}',
    invocation: 'frames(0,new Error("ours"))',
    refused: false,
  },
];

describe('native Set mixed position readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-encoding-callbacks.ts', source);
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

describe('shared native Set mixed positions', () => {
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
