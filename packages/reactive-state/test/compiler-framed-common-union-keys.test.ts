import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native conditional utilities and common written union keys retain selected error results. */
const CASES = [
  {
    id: 'common-error-key',
    source:
      'type Box={failure:Error;left:string}|{failure:Error;right:number};type Failure=Box[keyof Box];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'common-data-only-key',
    source:
      'type Box={failure:Error;data:{stack:string}}|{data:{stack:string};right:number};type Failure=Box[keyof Box];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'common-generic-error-key',
    source:
      'type Box<T>={failure:T;left:string}|{failure:T;right:number};type Failure=Box<Error>[keyof Box<Error>];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'common-mixed-error-key',
    source:
      'type Box={failure:Error;left:string}|{failure:{stack:string};right:number};type Failure=Box[keyof Box];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'common-aliased-error-key',
    source:
      'type A={failure:Error;left:string};type B={failure:Error;right:number};type Box=A|B;type Key=keyof Box;type Failure=Box[Key];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'common-numeric-error-key',
    source:
      'type Box={0:Error;left:string}|{0:Error;right:number};type Failure=Box[keyof Box];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('common-union-keys readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-noinfer.ts', source);
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

describe('shared common-union-keys results', () => {
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

    expect(reasons).toStrictEqual(refused ? [shared] : []);
  });
});
