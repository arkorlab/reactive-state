import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native conditional utilities and common written union keys retain selected error results. */
const CASES = [
  {
    id: 'exclude-empty-object-data',
    source:
      'type Failure=Exclude<Error,{}>|{stack:string};function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-empty-object-error',
    source: 'type Failure=Extract<Error,{}>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'exclude-null-retained-data',
    source:
      'type Failure=Exclude<null,{}> extends null?{stack:string}:Error;function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-nullish-empty-data',
    source:
      'type Failure=Extract<null|undefined,{}> extends never?{stack:string}:Error;function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'exclude-nonnull-primitives-data',
    source:
      'type Failure=Exclude<string|number,{}> extends never?{stack:string}:Error;function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-written-primitive-data',
    source:
      'type Failure=Extract<string,{}> extends string?{stack:string}:Error;function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-unknown-empty-data',
    source:
      'type Failure=Extract<unknown,{}> extends never?{stack:string}:Error;function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'exclude-shadowed-error-data',
    source:
      'type Error={stack:string};type Failure=Exclude<Error,{}>|{stack:string};function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
];

describe('empty-object-utilities readers', () => {
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

describe('shared empty-object-utilities results', () => {
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
