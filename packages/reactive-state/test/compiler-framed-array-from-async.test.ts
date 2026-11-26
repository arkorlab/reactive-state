import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** An awaited native Array.fromAsync of a written array holds its elements' settled values. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const OURS = 'frames(new Error("ours"))';

const CASES: readonly Case[] = [
  {
    id: 'from-async-review',
    source: 'async function frames(error:Error){return(await Array.fromAsync([error]))[0]!.stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'from-async-message',
    source:
      'async function frames(error:Error){return(await Array.fromAsync([error]))[0]!.message;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'from-async-resolved-error',
    source:
      'async function frames(error:Error){return(await Array.fromAsync([Promise.resolve(error)]))[0]!.stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'from-async-second-element',
    source:
      'async function frames(error:Error){return(await Array.fromAsync([{stack:"fixed"},error]))[1]!.stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'from-async-source-alias',
    source:
      'async function frames(error:Error){const input=[error];return(await Array.fromAsync(input))[0]!.stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'from-async-fresh-error',
    source: 'async function frames(){return(await Array.fromAsync([new Error("x")]))[0]!.stack;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'from-async-undefined-mapper',
    source:
      'async function frames(error:Error){return(await Array.fromAsync([error],undefined))[0]!.stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'from-async-data-pin',
    source:
      'async function frames(error:Error){return(await Array.fromAsync([{stack:"fixed"}]))[0]!.stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'from-async-other-index-pin',
    source:
      'async function frames(error:Error){return(await Array.fromAsync([error,{stack:"fixed"}]))[1]!.stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'from-async-hole-pin',
    source:
      'async function frames(error:Error){return(await Array.fromAsync([,error]))[0]?.stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'from-async-mapper-pin',
    source:
      'async function frames(error:Error){return(await Array.fromAsync([error],()=>({stack:"fixed"})))[0]!.stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'from-async-thenable-pin',
    source:
      'async function frames(error:Error){return(await Array.fromAsync([{then(resolve:(value:{stack:string})=>void){resolve({stack:"fixed"});}}]))[0]!.stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'from-async-local-words-pin',
    source:
      'async function frames(error:Error){return(await Array.fromAsync([new Error("fixed")]))[0]!.message;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'from-async-prior-write-pin',
    source:
      'async function frames(error:Error){Object.defineProperty(error,"stack",{value:"fixed"});return(await Array.fromAsync([error]))[0]!.stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'from-async-saved-result-pin',
    source:
      'async function frames(error:Error){const values=await Array.fromAsync([error]);Object.assign(error,{stack:"fixed"});return values[0]!.stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'from-async-unknown-iterable-pin',
    source:
      'async function frames(error:Error,values:AsyncIterable<{stack:string}>){return(await Array.fromAsync(values))[0]!.stack;}',
    invocation: 'frames(new Error("ours"),(async function*(){yield{stack:"fixed"};})())',
    refused: false,
  },
];

describe('native Array.fromAsync readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-from-async.ts', source);
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

describe('shared native Array.fromAsync admissions', () => {
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
