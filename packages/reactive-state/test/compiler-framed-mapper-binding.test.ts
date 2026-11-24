import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'destructured-map-error',
    source: 'function frames(error:Error){return[{error}].map(({error})=>error)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'destructured-map-data',
    source:
      'function frames(error:Error){return[{error:{stack:"fixed"}}].map(({error})=>error)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'nested-mapper-path',
    source:
      'function frames(error:Error){return[{box:{error}}].map(({box:{error}})=>error)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'renamed-mapper-path',
    source:
      'function frames(error:Error){return[{failure:error}].map(({failure:value})=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'multiple-mapper-paths',
    source:
      'function frames(error:Error){return[{failure:error,safe:{stack:"fixed"}}].map(({failure,safe})=>error.name?failure:safe)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'selected-data-position',
    source:
      'function frames(error:Error){return[{error:{stack:"fixed"}},{error}].map(({error})=>error)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'typed-holder-error',
    source:
      'function frames(error:Error){const values:{error:Error}[]=[{error}];return values.map(({error})=>error)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'typed-holder-data',
    source:
      'function frames(error:Error){const values:{error:{stack:string}}[]=[{error:{stack:"fixed"}}];return values.map(({error})=>error)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'whole-parameter-error',
    source: 'function frames(error:Error){return[error].map(value=>value)[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'local-made-words-data',
    source:
      'function frames(error:Error){return[new Error("fixed")].map(({message})=>({stack:message}))[0]!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
];

describe('mapper selected binding readers', () => {
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

describe('mapper selected binding admissions', () => {
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
