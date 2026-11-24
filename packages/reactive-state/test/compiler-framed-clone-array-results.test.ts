import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native clone and element selectors preserve source-written error receivers. */
const CASES = [
  {
    id: 'clone-native-stack',
    source: "function frames(){return structuredClone(new Error('ours')).stack;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'clone-supplied-words',
    source: 'function frames(error:Error){return structuredClone(error).message;}',
    invocation: "frames(new Error('ours'))",
    refused: true,
  },
  {
    id: 'clone-written-words',
    source: "function frames(){return structuredClone(new Error('ours')).message;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'clone-ordinary-data',
    source: "function frames(){return structuredClone({stack:'fixed'}).stack;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'clone-shadowed-function',
    source:
      "function frames(){const structuredClone=(_value:unknown)=>({stack:'fixed'});return structuredClone(new Error('ours')).stack;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'clone-globalthis-stack',
    source: "function frames(){return globalThis.structuredClone(new Error('ours')).stack;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'at-literal-stack',
    source: "function frames(){return [new Error('ours')].at(0)!.stack;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'at-negative-stack',
    source: "function frames(){return [{stack:'fixed'},new Error('ours')].at(-1)!.stack;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'at-typed-error-stack',
    source: 'function frames(errors:Error[],index:number){return errors.at(index)!.stack;}',
    invocation: "frames([new Error('ours')],0)",
    refused: true,
  },
  {
    id: 'at-typed-tuple-stack',
    source: 'function frames(errors:[{stack:string},Error]){return errors.at(1)!.stack;}',
    invocation: "frames([{stack:'fixed'},new Error('ours')])",
    refused: true,
  },
  {
    id: 'at-literal-selected-data',
    source: "function frames(){return [{stack:'fixed'},new Error('ours')].at(0)!.stack;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'at-typed-selected-data',
    source: 'function frames(errors:[{stack:string},Error]){return errors.at(0)!.stack;}',
    invocation: "frames([{stack:'fixed'},new Error('ours')])",
    refused: false,
  },
  {
    id: 'at-out-of-bounds',
    source: "function frames(){return [new Error('ours')].at(2)?.stack;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'at-native-override',
    source:
      "function frames(error:Error){const values=[error];values.at=()=>({stack:'fixed'} as Error);return values.at(0)!.stack;}",
    invocation: "frames(new Error('ours'))",
    refused: true,
  },
  {
    id: 'at-local-object-method',
    source:
      "function frames(){const values={at(_index:number){return {stack:'fixed'};}};return values.at(0).stack;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'at-written-words',
    source: "function frames(){return [new Error('ours')].at(0)!.message;}",
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'at-supplied-words',
    source: 'function frames(error:Error){return [error].at(0)!.message;}',
    invocation: "frames(new Error('ours'))",
    refused: true,
  },
  {
    id: 'at-const-index',
    source:
      "function frames(){const index=1;return [{stack:'fixed'},new Error('ours')].at(index)!.stack;}",
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'at-alias-cycle',
    source: 'function frames(){const first=second;const second=first;return first.at(0).stack;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'at-typed-negative-stack',
    source: 'function frames(errors:[{stack:string},Error]){return errors.at(-1)!.stack;}',
    invocation: "frames([{stack:'fixed'},new Error('ours')])",
    refused: true,
  },
  {
    id: 'at-typed-negative-data',
    source: 'function frames(errors:[{stack:string},Error]){return errors.at(-2)!.stack;}',
    invocation: "frames([{stack:'fixed'},new Error('ours')])",
    refused: false,
  },
  {
    id: 'at-typed-out-of-bounds',
    source: 'function frames(errors:[Error]){return errors.at(2)?.stack;}',
    invocation: "frames([new Error('ours')])",
    refused: false,
  },
  {
    id: 'at-default-selected-data',
    source: "function frames(){return [{stack:'fixed'},new Error('ours')].at()!.stack;}",
    invocation: 'frames()',
    refused: false,
  },
];

describe('native clone and array result readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'clone-array-results.ts', source);
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

describe('shared native clone and array results', () => {
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
