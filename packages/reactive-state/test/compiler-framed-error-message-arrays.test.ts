import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A native Error message converts an array as `String` does, with the words of the errors it holds. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-error-array-message',
    source: 'function frames(error:Error){return new Error([error]as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'error-call-array-message',
    source: 'function frames(error:Error){return Error([error]as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'type-error-array-message',
    source: 'function frames(error:Error){return new TypeError([error]as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'dom-exception-array-message',
    source: 'function frames(error:Error){return new DOMException([error]as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'aggregate-array-message',
    source: 'function frames(error:Error){return new AggregateError([],[error]as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'nested-array-message',
    source: 'function frames(error:Error){return new Error([[error]]as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'aliased-array-message',
    source:
      'function frames(error:Error){const list=[error];return new Error(list as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'typed-array-message',
    source: 'function frames(errors:Error[]){return new Error(errors as never).message;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'reflected-array-message',
    source:
      'function frames(error:Error){return Reflect.construct(Error,[[error]as never]).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'spread-array-message',
    source:
      'function frames(error:Error){const args=[[error]as never]as const;return new Error(...args).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'local-words-array-message',
    source: 'function frames(error:Error){return new Error([new Error("fixed")]as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'data-array-message',
    source: 'function frames(error:Error){return new Error(["fixed"]as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-tostring-array-message',
    source:
      'function frames(error:Error){const list=[error];list.toString=()=>"fixed";return new Error(list as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'cause-array-not-converted',
    source: 'function frames(error:Error){return new Error("fixed",{cause:[error]}).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'aggregate-errors-not-converted',
    source: 'function frames(error:Error){return new AggregateError([[error]],"fixed").message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'direct-error-message',
    source: 'function frames(error:Error){return new Error(error as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('error message array readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'error-message-arrays.ts', source);
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

describe('shared error message array admissions', () => {
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
