import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Error observations retain runtime identity and source-written data boundaries. */
const CASES = [
  {
    id: 'loop-target-write',
    source:
      'function frames(error:Error){const args:[unknown,string]=[{stack:"fixed"},"stack"];let result="";for(let i=0;i<2;i++){result=Reflect.get(...args) as string;args[0]=error;}return result;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'loop-key-write',
    source:
      'function frames(error:Error){const args:[Error,string]=[error,"plain"];let result="";for(let i=0;i<2;i++){result=Reflect.get(...args) as string;args[1]="stack";}return result;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'loop-whole-alias',
    source:
      'function frames(error:Error){const args:[unknown,string]=[{stack:"fixed"},"stack"];const alias=args;let result="";for(let i=0;i<2;i++){result=Reflect.get(...alias) as string;args[0]=error;}return result;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'loop-update-target-write',
    source:
      'function frames(error:Error){const args:[unknown,string]=[{stack:"fixed"},"stack"];let result="";for(let i=0;(result=Reflect.get(...args) as string,i<2);i++,args[0]=error){}return result;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'later-outside-loop',
    source:
      'function frames(error:Error){const args:[unknown,string]=[{stack:"fixed"},"stack"];const result=Reflect.get(...args) as string;args[0]=error;return result;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'singleton-loop',
    source:
      'function frames(error:Error){const args:[unknown,string]=[{stack:"fixed"},"stack"];let result="";for(const i of [0]){result=Reflect.get(...args) as string;args[0]=error;}return result;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'fresh-each-iteration',
    source:
      'function frames(error:Error){let result="";for(let i=0;i<2;i++){const args:[unknown,string]=[{stack:"fixed"},"stack"];result=Reflect.get(...args) as string;args[0]=error;}return result;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unselected-loop-write',
    source:
      'function frames(error:Error){const args:[unknown,string]=[{stack:"fixed"},"stack"];let result="";for(let i=0;i<2;i++){result=Reflect.get(...args) as string;if(false)args[0]=error;}return result;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'loop-ordinary-data',
    source:
      'function frames(){const args:[unknown,string]=[{stack:"fixed"},"stack"];let result="";for(let i=0;i<2;i++){result=Reflect.get(...args) as string;args[0]={stack:"next"};}return result;}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'stable-error-nonframe-key',
    source:
      'function frames(error:Error){const args:[Error,string]=[error,"plain"];let result="";for(let i=0;i<2;i++){result=Reflect.get(...args) as string;}return result;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('loop-tuples readers', () => {
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

describe('shared loop-tuples', () => {
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
