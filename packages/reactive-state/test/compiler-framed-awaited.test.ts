import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native utility and object-identity boundaries preserve Error observations and data. */
const CASES = [
  {
    id: 'awaited-native-error',
    source: 'function frames(error:Awaited<Error>){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'awaited-native-type-error',
    source: 'function frames(error:Awaited<TypeError>){return error.stack;}',
    invocation: 'frames(new TypeError("ours"))',
    refused: true,
  },
  {
    id: 'awaited-native-words',
    source: 'function frames(error:Awaited<Error>){return error.message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'awaited-generic-actual',
    source: 'type Value<T>=Awaited<T>;function frames(error:Value<Error>){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'awaited-generic-default',
    source: 'type Value<T=Error>=Awaited<T>;function frames(error:Value){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'awaited-data',
    source: 'function frames(error:Awaited<{stack:string}>){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'awaited-generic-data',
    source:
      'type Value<T>=Awaited<T>;function frames(error:Value<{stack:string}>){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'awaited-local-shadow',
    source:
      'type Awaited<T>={stack:string};function frames(error:Awaited<Error>){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'awaited-thenable-error-data',
    source:
      'type Value=Awaited<Error&{then(onfulfilled:(value:{stack:string})=>unknown):unknown}>;function frames(error:Value){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
];

describe('awaited readers', () => {
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

describe('shared awaited results', () => {
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
