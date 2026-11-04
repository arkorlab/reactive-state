import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A supplied Error keeps its possible frames when a write is not shown to install own data. */
const CASES = [
  {
    id: 'ordinary-cause-parameter-conservative-pin',
    source:
      "function frames(error:Error){return (new Error({toString(){Object.assign(error,{stack:'fixed'});return 'ours';}} as never,{cause:error}).cause as {stack:string}).stack;}",
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'intercepting-Proxy-Error-cause-pin',
    source:
      "function frames(error:Error){return (new Error({toString(){Object.assign(error,{stack:'fixed'});return 'ours';}} as never,{cause:error}).cause as {stack:string}).stack;}",
    refused: true,
    invocation:
      '(()=>{const error=new Proxy(new Error("ours"),{get(target,key){return Reflect.get(target,key,target);},set(target,key,value,receiver){return key==="stack"||Reflect.set(target,key,value,receiver);}});return frames(error);})()',
  },
  {
    id: 'literal-cause-data-remains-data',
    source:
      'function frames(){return(new Error("ours",{cause:{stack:"fixed"}}).cause as{stack:string}).stack;}',
    refused: false,
    invocation: 'frames()',
  },
];

describe('conservative Error cause readers', () => {
  it.each(CASES)('$id', ({ source, invocation, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'cause-input-boundary.ts', `${source}\n${invocation}`);
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

describe('shared conservative Error cause text', () => {
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
