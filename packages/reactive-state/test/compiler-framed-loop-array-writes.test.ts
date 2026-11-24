import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Error observations retain runtime identity and source-written data boundaries. */
const CASES = [
  {
    id: 'loop-index-write',
    source:
      'function frames(error:Error){const values:unknown[]=["fixed"];let result="";for(let i=0;i<2;i++){result=values.join();values[0]=error;}return result;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'loop-push-write',
    source:
      'function frames(error:Error){const values:unknown[]=["fixed"];let result="";for(let i=0;i<2;i++){result=values.join();values.push(error);}return result;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'loop-at-write',
    source:
      'function frames(error:Error){const values:unknown[]=[{stack:"fixed"}];let result="";for(let i=0;i<2;i++){result=(values.at(0) as {stack:string}).stack;values[0]=error;}return result;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'loop-condition-index-write',
    source:
      'function frames(error:Error){const values:unknown[]=["fixed"];let result="";let i=0;do{result=values.join();}while((values[0]=error,i++<1));return result;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'singleton-array-loop',
    source:
      'function frames(error:Error){const values:unknown[]=["fixed"];let result="";for(const i of [0]){result=values.join();values[0]=error;}return result;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'fresh-array-per-iteration',
    source:
      'function frames(error:Error){let result="";for(let i=0;i<2;i++){const values:unknown[]=["fixed"];result=values.join();values[0]=error;}return result;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unselected-loop-write',
    source:
      'function frames(error:Error){const values:unknown[]=["fixed"];let result="";for(let i=0;i<2;i++){result=values.join();if(false)values[0]=error;}return result;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'later-nonrepeated-write',
    source:
      'function frames(error:Error){const values:unknown[]=["fixed"];const result=values.join();values[0]=error;return result;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'loop-other-selected-index',
    source:
      'function frames(error:Error){const values:unknown[]=[{stack:"fixed"},null];let result="";for(let i=0;i<2;i++){result=(values.at(0) as {stack:string}).stack;values[1]=error;}return result;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('loop-array-writes readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'recursive-error-members.ts', source);
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

describe('shared loop-array-writes', () => {
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
