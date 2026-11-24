import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native Promise.any, like race, of immediately fulfilled inputs settles with its first source value. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const OURS = 'frames(new Error("ours"))';

const CASES: readonly Case[] = [
  {
    id: 'any-review',
    source: 'async function frames(){return(await Promise.any([new Error("x")])).stack;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'any-supplied-error',
    source: 'async function frames(error:Error){return(await Promise.any([error])).stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'any-supplied-message',
    source: 'async function frames(error:Error){return(await Promise.any([error])).message;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'any-resolved-error',
    source:
      'async function frames(error:Error){return(await Promise.any([Promise.resolve(error)])).stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'any-first-error-before-data',
    source:
      'async function frames(error:Error){return(await Promise.any([error,{stack:"fixed"}])).stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'any-input-alias',
    source:
      'async function frames(error:Error){const input=[error];return(await Promise.any(input)).stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'any-native-constructor-alias',
    source:
      'async function frames(error:Error){const Native=Promise;return(await Native.any([error])).stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'any-global-this',
    source:
      'async function frames(error:Error){return(await globalThis.Promise.any([error])).stack;}',
    invocation: OURS,
    refused: true,
  },
  {
    id: 'any-resolved-fresh-error',
    source:
      'async function frames(){return(await Promise.any([Promise.resolve(new Error("x"))])).stack;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'race-fresh-error',
    source: 'async function frames(){return(await Promise.race([new Error("x")])).stack;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'any-data-pin',
    source:
      'async function frames(error:Error){return(await Promise.any([{stack:"fixed"}])).stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'any-first-data-before-error-pin',
    source:
      'async function frames(error:Error){return(await Promise.any([{stack:"fixed"},error])).stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'any-local-words-pin',
    source:
      'async function frames(error:Error){return(await Promise.any([new Error("fixed")])).message;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'any-empty-input-pin',
    source:
      'async function frames(error:Error){return((await Promise.any([]))as{stack?:string}).stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'any-local-promise-pin',
    source:
      'async function frames(error:Error){const Promise={any:(values:unknown[])=>({stack:"fixed",values})};return(await Promise.any([error])).stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'any-saved-result-later-write-pin',
    source:
      'async function frames(error:Error){const value=await Promise.any([error]);Object.assign(value,{stack:"fixed"});return value.stack;}',
    invocation: OURS,
    refused: false,
  },
  {
    id: 'any-ignored-tail-rewrite-pin',
    source:
      'async function frames(error:Error){return(await(Promise.any as(...args:unknown[])=>Promise<Error>)([error],Object.assign(error,{stack:"fixed"}))).stack;}',
    invocation: OURS,
    refused: false,
  },
];

describe('native Promise.any readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'promise-any.ts', source);
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

describe('shared native Promise.any admissions', () => {
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
