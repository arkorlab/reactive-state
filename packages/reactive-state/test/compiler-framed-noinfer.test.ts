import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native NoInfer preserves its argument identity while local utility names retain their meaning. */
const CASES = [
  {
    id: 'native-noinfer-stack',
    source: 'function frames(error:NoInfer<Error>){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-noinfer-supplied-words',
    source: 'function frames(error:NoInfer<Error>){return error.message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'native-noinfer-data',
    source: 'function frames(error:NoInfer<{stack:string}>){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'generic-actual-error',
    source: 'type Wrapped<T>=NoInfer<T>;function frames(error:Wrapped<Error>){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-default-error',
    source: 'type Wrapped<T=Error>=NoInfer<T>;function frames(error:Wrapped){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-actual-data',
    source:
      'type Wrapped<T>=NoInfer<T>;function frames(error:Wrapped<{stack:string}>){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'selected-nested-error',
    source: 'function frames(box:NoInfer<{error:Error}>){return box.error.stack;}',
    invocation: 'frames({error:new Error("ours")})',
    refused: true,
  },
  {
    id: 'local-utility-shadow-data',
    source:
      'type NoInfer<T>={stack:string};function frames(error:NoInfer<Error>){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'local-utility-shadow-error',
    source:
      'type NoInfer<T>=Error;function frames(error:NoInfer<{stack:string}>){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'mutable-receiver-error-write',
    source:
      'function frames(incoming:Error){let error:NoInfer<Error|{stack:string}>={stack:"fixed"};error=incoming;return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'readonly-native-noinfer-error',
    source: 'function frames(error:Readonly<NoInfer<Error>>){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'readonly-native-noinfer-data',
    source: 'function frames(error:Readonly<NoInfer<{stack:string}>>){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
];

describe('native NoInfer readers', () => {
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

describe('shared native NoInfer results', () => {
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
