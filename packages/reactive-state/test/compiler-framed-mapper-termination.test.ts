import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'recursive-self-mapper-data',
    source:
      'interface Holder{child:Holder;stack:string}function frames(items:Holder[]){items=items.map(({child})=>child);return items[0]!.stack;}',
    invocation: 'frames([{child:{child:null!,stack:"fixed"},stack:"fixed"}])',
    reader: false,
    refused: false,
  },
  {
    id: 'rest-mapper-error',
    source:
      'function frames(error:Error){const[_,...values]=[{error:{stack:"fixed"}},{error}];return values.map(({error})=>error)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'independent-sibling-paths',
    source:
      'function frames(error:Error,flag:boolean){return[{failure:error,safe:{stack:"fixed"}}].map(({failure,safe})=>flag?failure:safe)[0]!.stack;}',
    invocation: 'frames(new Error("ours"),true)',
    reader: true,
    refused: true,
  },
];

describe('mapper termination and rest readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-error-observations.ts', source);
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

describe('mapper termination and rest admissions', () => {
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
