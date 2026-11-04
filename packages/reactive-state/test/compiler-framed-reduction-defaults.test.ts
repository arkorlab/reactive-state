import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A reducer's returned parameter keeps the written defaults its incoming value leaves to apply. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly refused: boolean;
}

const MAYBE = '([undefined]as(Error|undefined)[])';

const CASES: readonly Case[] = [
  {
    id: 'reduce-accumulator-default-review',
    source: `function frames(error:Error){return ${MAYBE}.reduce((value=error)=>value,undefined)!.stack;}`,
    refused: true,
  },
  {
    id: 'reduce-right-accumulator-default',
    source: `function frames(error:Error){return ${MAYBE}.reduceRight((value=error)=>value,undefined)!.stack;}`,
    refused: true,
  },
  {
    id: 'reduce-accumulator-default-words',
    source: `function frames(error:Error){return ${MAYBE}.reduce((value=error)=>value,undefined)!.message;}`,
    refused: true,
  },
  {
    id: 'reduce-element-default',
    source:
      'function frames(error:Error){return([1,undefined]as(number|Error|undefined)[]).reduce((accumulator,value=error)=>value)!.stack;}',
    refused: true,
  },
  {
    id: 'reduce-pattern-default',
    source:
      'function frames(error:Error){return([undefined]as({failure?:Error}|undefined)[]).reduce(({failure=error}:{failure?:Error}={})=>failure,undefined)!.stack;}',
    refused: true,
  },
  {
    id: 'reduce-present-initial-pin',
    source:
      'function frames(error:Error){return([{stack:"fixed"}]as{stack?:string}[]).reduce((value:{stack?:string}=error)=>value,{stack:"fixed"})!.stack;}',
    refused: false,
  },
  {
    id: 'reduce-present-accumulator-pin',
    source:
      'function frames(error:Error){return([{stack:"fixed"},undefined]as({stack?:string}|undefined)[]).reduce((accumulator,value:{stack?:string}|undefined=error)=>accumulator)!.stack;}',
    refused: false,
  },
  {
    id: 'reduce-saved-result-pin',
    source: `function frames(error:Error){const result=${MAYBE}.reduce((value=error)=>value,undefined)!;Object.assign(result,{stack:"fixed"});return result.stack;}`,
    refused: false,
  },
  {
    id: 'reduce-effectful-body-pin',
    source: `function frames(error:Error){return ${MAYBE}.reduce((value=error)=>{Object.assign(value,{stack:"fixed"});return value;},undefined)!.stack;}`,
    refused: false,
  },
  {
    id: 'reduce-local-words-pin',
    source: `function frames(error:Error){return ${MAYBE}.reduce((value=new Error("fixed"))=>value,undefined)!.message;}`,
    refused: false,
  },
];

describe('reduction default readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'reduction-defaults.ts', source);
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

describe('shared reduction default admissions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error("ours"))).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
