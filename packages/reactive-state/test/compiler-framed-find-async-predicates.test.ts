import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native find and findLast answer the first or last element an async predicate's Promise keeps. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'find-async-false',
    source: 'function frames(error:Error){return[error].find(async()=>false)!.stack;}',
    refused: true,
  },
  {
    id: 'find-async-false-words',
    source: 'function frames(error:Error){return[error].find(async()=>false)!.message;}',
    refused: true,
  },
  {
    id: 'find-last-async-false',
    source:
      'function frames(error:Error){return[{stack:"fixed"},error].findLast(async()=>false)!.stack;}',
    refused: true,
  },
  {
    id: 'find-async-zero',
    source: 'function frames(error:Error){return[error].find(async()=>0)!.stack;}',
    refused: true,
  },
  {
    id: 'find-async-plain-parameter',
    source: 'function frames(error:Error){return[error].find(async(value)=>false)!.stack;}',
    refused: true,
  },
  {
    id: 'find-async-source-alias',
    source:
      'function frames(error:Error){const input=[error];return input.find(async()=>false)!.stack;}',
    refused: true,
  },
  {
    id: 'find-async-borrowed-call',
    source:
      'function frames(error:Error){return(Array.prototype.find.call([error],async()=>false)as Error).stack;}',
    refused: true,
  },
  {
    id: 'find-async-true-first-data',
    source:
      'function frames(error:Error){return[{stack:"fixed"},error].find(async()=>true)!.stack;}',
    refused: false,
  },
  {
    id: 'find-async-first-data-pin',
    source:
      'function frames(error:Error){return[{stack:"fixed"},error].find(async()=>false)!.stack;}',
    refused: false,
  },
  {
    id: 'find-last-async-data-pin',
    source:
      'function frames(error:Error){return[error,{stack:"fixed"}].findLast(async()=>false)!.stack;}',
    refused: false,
  },
  {
    id: 'find-async-hole-pin',
    source: 'function frames(error:Error){return[,error].find(async()=>false)?.stack;}',
    refused: false,
  },
  {
    id: 'find-sync-false-pin',
    source: 'function frames(error:Error){return[error].find(()=>false)?.stack;}',
    refused: false,
  },
  {
    id: 'find-async-local-words-pin',
    source:
      'function frames(error:Error){return[new Error("fixed")].find(async()=>false)!.message;}',
    refused: false,
  },
  {
    id: 'find-async-tail-effect-pin',
    source:
      'function frames(error:Error){return([error].find as(...args:unknown[])=>Error|undefined)(async()=>false,Object.assign(error,{stack:"fixed"}))!.stack;}',
    refused: true,
  },
  {
    id: 'find-async-saved-result-pin',
    source:
      'function frames(error:Error){const found=[error].find(async()=>false);Object.assign(error,{stack:"fixed"});return found!.stack;}',
    refused: true,
  },
  {
    id: 'async-find-loop-replace',
    source:
      'function frames(error:Error){const input:Array<{stack?:string}>=[{stack:"fixed"}];let result:unknown;let i=0;do result=input.find(async()=>true)!.stack;while((input[0]=error,i++<1));return result;}',
    refused: true,
  },
  {
    id: 'async-find-loop-replace-data',
    source:
      'function frames(error:Error){const input:Array<{stack?:string}>=[{stack:"fixed"}];const spare:Array<{stack?:string}>=[];let result:unknown;let i=0;do result=input.find(async()=>true)!.stack;while((spare[0]=error,i++<1));return result;}',
    refused: false,
  },
];

describe('async find predicate readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'find-async.ts', source);
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

describe('shared async find predicate admissions', () => {
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
