import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A naked parameter distributes over `boolean`'s two literals, each bound for the branches that read it. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-boolean-tuple-select',
    source:
      'type Select<T>=T extends boolean?([boolean] extends [T]?{stack:string}:Error):never;function frames(value:Select<boolean>){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'union-with-boolean',
    source:
      'type Select<T>=T extends boolean?([boolean] extends [T]?{stack:string}:Error):{stack:string};function frames(value:Select<string|boolean>){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'boolean-alias-argument',
    source:
      'type Flag=boolean;type Select<T>=T extends boolean?([boolean] extends [T]?{stack:string}:Error):never;function frames(value:Select<Flag>){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'outer-alias-argument',
    source:
      'type Select<T>=T extends boolean?([boolean] extends [T]?{stack:string}:Error):never;type Outer<T>=Select<T>;function frames(value:Outer<boolean>){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reported-nested-true-select',
    source:
      'type Select<T>=T extends true?(T extends true?{stack:string}:Error):{stack:string};type Failure=Select<boolean>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'nested-false-select',
    source:
      'type Select<T>=T extends false?(T extends false?{stack:string}:Error):{stack:string};function frames(value:Select<boolean>){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'nested-alias-select',
    source:
      'type Flag=boolean;type Select<T>=T extends true?(T extends true?{stack:string}:Error):{stack:string};function frames(value:Select<Flag>){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'split-boolean-refused',
    source:
      'type Split<T>=T extends true?Error:{stack:string};function frames(value:Split<boolean>){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'concrete-true-refused',
    source:
      'type Select<T>=T extends boolean?([boolean] extends [T]?{stack:string}:Error):never;function frames(value:Select<true>){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'wrapped-check-data',
    source:
      'type Wrapped<T>=[T] extends [true]?Error:{stack:string};function frames(value:Wrapped<boolean>){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'wrapped-both-refused',
    source:
      'type WrappedBoth<T>=[T] extends [boolean]?Error:{stack:string};function frames(value:WrappedBoth<boolean>){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('boolean distribution readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'boolean-distribution.ts', source);
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

describe('shared boolean distribution admissions', () => {
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
