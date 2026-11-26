import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Written finite key selections retain only their syntax-known member possibilities. */
const CASES = [
  {
    id: 'literal-keyof-error',
    source:
      'type Failure={error:Error}[keyof {error:Error}];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-keyof-alias',
    source:
      'type Box<T>={error:T};type All<T>=T[keyof T];type Failure=All<Box<Error>>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'optional-keyof-error',
    source:
      'type Box={error?:Error};type Failure=Box[keyof Box];function frames(error:Failure){return error!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'numeric-keyof-error',
    source:
      'type Failure={0:Error}[keyof {0:Error}];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'keyof-data',
    source:
      'type Failure={data:{stack:string}}[keyof {data:{stack:string}}];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'keyof-unselected-error',
    source:
      'type Failure={error:Error;data:{stack:string}}[keyof {data:string}];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'keyof-local-Error',
    source:
      'type Error={stack:string};type Box<T>={error:T};type Failure=Box<Error>[keyof Box<Error>];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'keyof-unproductive-cycle',
    source:
      'type Keys=Keys;type Failure={error:Error}[keyof Keys];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({} as never)',
    refused: false,
  },
  {
    id: 'keyof-union-common-data',
    source:
      'type Failure={error:Error;data:{stack:string}}[keyof ({error:Error;data:string}|{data:string})];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
];

describe('keyof type selections readers', () => {
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

describe('shared keyof type selections', () => {
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
