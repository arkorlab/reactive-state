import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Only the native operation's consumed values expose supplied Error words. */
const CASES = [
  {
    id: 'destructured-parameter-query-error',
    source:
      'function frames({failure}:{failure:Error}){type Raised=typeof failure;function words(value:Raised){return value.stack;}return words(failure);}',
    invocation: 'frames({failure:new Error("ours")})',
    refused: true,
    reader: true,
  },
  {
    id: 'destructured-native-message-query-data',
    source:
      'const {message}=new Error("fixed");type Value=typeof message;function frames(value:Value){return(value as unknown as{stack:string}).stack;}',
    invocation: 'frames("fixed")',
    refused: false,
    reader: false,
  },
  {
    id: 'query-selected-parameter-alias',
    source:
      'function frames({failure:renamed}:{failure:Error}){const alias=renamed;function read(value:typeof alias){return value.stack;}return read(alias);}',
    invocation: 'frames({failure:new Error("ours")})',
    refused: true,
    reader: true,
  },
  {
    id: 'query-selected-data-annotation',
    source:
      'function frames({failure}:{failure:{stack:string}}){function read(value:typeof failure){return value.stack;}return read(failure);}',
    invocation: 'frames({failure:{stack:"fixed"}})',
    refused: false,
    reader: false,
  },
  {
    id: 'query-selected-nested-generic',
    source:
      'function frames<T extends Error>({group:{failure}}:{group:{failure:T}}){function read(value:typeof failure){return value.stack;}return read(failure);}',
    invocation: 'frames({group:{failure:new Error("ours")}})',
    refused: true,
    reader: true,
  },
  {
    id: 'query-selected-literal-array-data',
    source:
      'const [word]=["fixed"];type Value=typeof word;function frames(value:Value){return(value as unknown as{stack:string}).stack;}',
    invocation: 'frames("fixed")',
    refused: false,
    reader: false,
  },
];

describe('selected local value query readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'selected-value-queries.ts', source);
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

describe('shared selected local value queries', () => {
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
