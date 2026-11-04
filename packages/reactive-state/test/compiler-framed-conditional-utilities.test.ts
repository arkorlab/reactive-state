import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native conditional utilities and common written union keys retain selected error results. */
const CASES = [
  {
    id: 'exclude-native-error',
    source:
      'type Failure=Exclude<Error,string>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-native-error',
    source: 'type Failure=Extract<Error,Error>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'exclude-generic-error',
    source:
      'type Value<T>=Exclude<T,string>;function frames(error:Value<Error>){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'extract-generic-default-error',
    source:
      'type Value<T=Error>=Extract<T,Error>;function frames(error:Value){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'exclude-removed-error-data',
    source:
      'type Failure=Exclude<Error,Error> extends never?{stack:string}:Error;function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-removed-error-data',
    source:
      'type Failure=Extract<Error,string> extends never?{stack:string}:Error;function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'exclude-local-shadow',
    source:
      'type Exclude<T,U>={stack:string};function frames(error:Exclude<Error,string>){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'extract-local-shadow',
    source:
      'type Extract<T,U>={stack:string};function frames(error:Extract<Error,Error>){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'exclude-distributed-union',
    source:
      'type Failure=Exclude<Error|string,string>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'exclude-union-target-data',
    source:
      'type Failure=Exclude<Error,Error|string> extends never?{stack:string}:Error;function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
];

describe('conditional-utilities readers', () => {
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

describe('shared conditional-utilities results', () => {
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

describe('conditional utility cycles', () => {
  it.each([
    'type Cycle<T>=Exclude<Cycle<T>,string>;function frames(error:Cycle<Error>){return error.stack;}',
    'type Cycle=Extract<Cycle,Error>;function frames(error:Cycle){return error.stack;}',
  ])('terminates while reading %s', (source) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'conditional-cycle.ts', source);
    const pending: Node[] = [parsed.sourceFile];

    expect(() => {
      for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
        framedRead(node);
        node.forEachChild((child) => {
          pending.push(child);
        });
      }
    }).not.toThrow();
  });
});
