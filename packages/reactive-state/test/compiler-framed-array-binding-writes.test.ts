import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A known own encoder method does not convert arguments by native Web IDL rules. */
const CASES = [
  {
    id: 'at-unannotated',
    source:
      'function frames(error:Error){let values=[];values=[error];return values.at(0)!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'at-any-array',
    source:
      'function frames(error:Error){let values:any[]=[];values=[error];return values.at(0).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'find-any-array',
    source:
      'function frames(error:Error){let values:any[]=[];values=[error];return values.find(()=>true).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'find-last-any-array',
    source:
      'function frames(error:Error){let values:any[]=[];values=[error];return values.findLast(()=>true).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'pop-any-array',
    source:
      'function frames(error:Error){let values:any[]=[];values=[error];return values.pop().stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'shift-any-array',
    source:
      'function frames(error:Error){let values:any[]=[];values=[error];return values.shift().stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-at-reassigned',
    source:
      'function frames(error:Error){let values:any[]=[];values=[error];return Array.prototype.at.call(values,0).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'reassigned-whole-alias',
    source:
      'function frames(error:Error){const next=[error];let values:any[]=[];values=next;return values.at(0).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'caught-array-words',
    source:
      'function frames(){let values:any[]=[];try{JSON.parse("{");}catch(error){values=[error];}return values.at(0).message;}',
    refused: true,
    invocation: 'frames()',
  },
  {
    id: 'local-made-frames',
    source:
      'function frames(){let values:any[]=[];values=[new Error("ours")];return values.at(0).stack;}',
    refused: true,
    invocation: 'frames()',
  },
  {
    id: 'initializer-error-pin',
    source: 'function frames(error:Error){const values=[error];return values.at(0)!.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'declared-error-array-pin',
    source: 'function frames(values:Error[]){return values.at(0)!.stack;}',
    refused: true,
    invocation: 'frames([new Error("ours")])',
  },
  {
    id: 'opaque-error-assertion-pin',
    source:
      'function frames(value:unknown){let values:unknown[]=[];values=[value];return (values.at(0) as Error).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'reassigned-data',
    source:
      'function frames(){let values:any[]=[];values=[{stack:"fixed"}];return values.at(0).stack;}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'local-made-words',
    source:
      'function frames(){let values:any[]=[];values=[new Error("ours")];return values.at(0).message;}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'known-false-assignment',
    source:
      'function frames(error:Error){let values:any[]=[{stack:"fixed"}];if(false)values=[error];return values.at(0).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'later-assignment',
    source:
      'function frames(error:Error){let values:any[]=[{stack:"fixed"}];const answer=values.at(0).stack;values=[error];return answer;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'lexical-shadow',
    source:
      'function frames(error:Error){const values=[{stack:"fixed"}];{let values:any[]=[];values=[error];void values;}return values.at(0)!.stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'own-at-implementation',
    source:
      'function frames(error:Error){let values:any[]=[];values=[error];values.at=()=>({stack:"fixed"});return values.at(0).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'custom-at-implementation',
    source:
      'function frames(error:Error){let values={at:(_index:number)=>({stack:"fixed"})};values={at:(_index:number)=>({stack:"fixed"})};return values.at(0).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'local-error-class-data',
    source:
      'class Error{stack="fixed";}function frames(){let values:any[]=[];values=[new Error()];return values.at(0).stack;}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'captured-array-before-later-rebind',
    source:
      'function frames(error:Error){let source:any[]=[{stack:"fixed"}];const values=source;source=[error];return values.at(0).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unselected-assigned-position',
    source:
      'function frames(error:Error){let values:any[]=[];values=[{stack:"fixed"},error];return values.at(0).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unknown-array-data-assertion',
    source:
      'function frames(error:Error){let values:unknown[]=[];values=[error];return (values.at(0) as {stack:string}).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'assigned-error-array-type',
    source:
      'function frames(source:Error[]){let values:any[]=[];values=source;return values.at(0).stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'assigned-data-array-type',
    source:
      'function frames(source:{stack:string}[]){let values:any[]=[];values=source;return values.at(0).stack;}',
    invocation: 'frames([{stack:"fixed"}])',
    refused: false,
  },
  {
    id: 'skipped-whole-logical-or',
    source:
      'function frames(error:Error){let values:any[]=[{stack:"fixed"}];values ||= [error];return values.at(0).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'skipped-whole-logical-nullish',
    source:
      'function frames(error:Error){let values:any[]=[{stack:"fixed"}];values ??= [error];return values.at(0).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('array whole-binding assignment readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-rebinding.ts', source);
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

describe('array whole-binding assignment shared', () => {
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
