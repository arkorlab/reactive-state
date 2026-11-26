import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'negative-last-error',
    source:
      'function frames(error:Error){const[_,...values]=[{stack:"fixed"},error];return values.at(-1)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'negative-two-prefixes-error',
    source:
      'function frames(error:Error){const[_,skip,...values]=[{stack:"fixed"},{stack:"fixed"},error];void skip;return values.at(-1)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'negative-middle-error',
    source:
      'function frames(error:Error){const[_,...values]=[{stack:"fixed"},error,{stack:"fixed"}];return values.at(-2)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'negative-source-alias-error',
    source:
      'function frames(error:Error){const source=[{stack:"fixed"},error];const[_,...values]=source;return values.at(-1)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'negative-typed-source-error',
    source:
      'function frames(source:Error[]){const[_,...values]=source;return values.at(-1)?.stack;}',
    invocation: 'frames([new Error("ours"),new Error("ours")])',
    reader: true,
    refused: true,
  },
  {
    id: 'negative-out-of-rest-bounds',
    source:
      'function frames(error:Error){const[_,...values]=[{stack:"fixed"},error];return values.at(-2)?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'negative-excluded-prefix-error',
    source:
      'function frames(error:Error){const[_,...values]=[error,{stack:"fixed"}];return values.at(-1)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'negative-unselected-middle-error',
    source:
      'function frames(error:Error){const[_,...values]=[{stack:"fixed"},error,{stack:"fixed"}];return values.at(-1)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'negative-zero-offset-error',
    source: 'function frames(error:Error){const[...values]=[error];return values.at(-1)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'positive-offset-error',
    source:
      'function frames(error:Error){const[_,...values]=[{stack:"fixed"},error];return values.at(0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'negative-local-words-data',
    source:
      'function frames(error:Error){const[_,...values]=[null,new Error("fixed")];return values.at(-1)?.message;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'negative-own-at-data',
    source:
      'function frames(error:Error){const[_,...values]=[{stack:"fixed"},error];values.at=()=>({stack:"fixed"})as never;return values.at(-1)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'negative-native-borrow-override-error',
    source:
      'function frames(error:Error){const[_,...values]=[{stack:"fixed"},error];values.at=()=>({stack:"fixed"})as never;return Array.prototype.at.call(values,-1)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'negative-nested-rest-error',
    source:
      'function frames(error:Error){const[_,...first]=[{stack:"fixed"},{stack:"fixed"},error];const[skip,...values]=first;void skip;return values.at(-1)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'negative-nested-rest-bound',
    source:
      'function frames(error:Error){const[_,...first]=[{stack:"fixed"},error,{stack:"fixed"}];const[skip,...values]=first;void skip;return values.at(-2)?.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
];

describe('negative array rest readers', () => {
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

describe('negative array rest admissions', () => {
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
