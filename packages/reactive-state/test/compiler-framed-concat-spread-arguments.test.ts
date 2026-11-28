import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native concat appends the arguments a source-known spread supplies, arrays spread in turn. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly refused: boolean;
}

const DATA = '([{stack:"fixed"}]as{stack?:string}[])';

const CASES: readonly Case[] = [
  {
    id: 'concat-spread-nested-array',
    source: `function frames(error:Error){return ${DATA}.concat(...[[error]])[1]!.stack;}`,
    refused: true,
  },
  {
    id: 'concat-spread-element',
    source: `function frames(error:Error){return ${DATA}.concat(...[error])[1]!.stack;}`,
    refused: true,
  },
  {
    id: 'concat-spread-alias',
    source: `function frames(error:Error){const args=[[error]];return ${DATA}.concat(...args)[1]!.stack;}`,
    refused: true,
  },
  {
    id: 'concat-spread-later-argument',
    source: `function frames(error:Error){return ${DATA}.concat(...[[{stack:"fixed"}],[error]])[2]!.stack;}`,
    refused: true,
  },
  {
    id: 'concat-borrowed-spread',
    source:
      'function frames(error:Error){return(Array.prototype.concat.call([{stack:"fixed"}],...[[error]])as{stack?:string}[])[1]!.stack;}',
    refused: true,
  },
  {
    id: 'concat-spread-data-pin',
    source: `function frames(error:Error){return ${DATA}.concat(...[[{stack:"other"}]])[1]!.stack;}`,
    refused: false,
  },
  {
    id: 'concat-spread-other-position-pin',
    source: `function frames(error:Error){return ${DATA}.concat(...[[{stack:"other"},error]])[1]!.stack;}`,
    refused: false,
  },
  {
    id: 'concat-spread-receiver-error-pin',
    source:
      'function frames(error:Error){return([error]as{stack?:string}[]).concat(...[[{stack:"fixed"}]])[0]!.stack;}',
    refused: true,
  },
  {
    id: 'concat-spread-local-words-pin',
    source:
      'function frames(error:Error){return([{message:"fixed"}]as{message?:string}[]).concat(...[[new Error("fixed")]])[1]!.message;}',
    refused: false,
  },
  {
    id: 'concat-call-spread',
    source:
      'function pack(e:Error):Error[][]{return [[e]];}function frames(error:Error){return ([{stack:"fixed"}]as{stack?:string}[]).concat(...pack(error))[1]!.stack;}',
    refused: true,
  },
  {
    id: 'concat-param-spread',
    source:
      'function frames(error:Error,args:Error[][]=[[error]]){return ([{stack:"fixed"}]as{stack?:string}[]).concat(...args)[1]!.stack;}',
    refused: true,
  },
  {
    id: 'concat-call-spread-titled-pin',
    source:
      "function pack():{stack?:string;title:string}[][]{return [[{stack:'fixed',title:'t'}]];}function frames(error:Error){void error;return ([{stack:'fixed',title:'t'}]as{stack?:string;title:string}[]).concat(...pack())[1]!.stack;}",
    refused: false,
  },
];

describe('concat spread argument readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'concat-spreads.ts', source);
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

describe('shared concat spread argument admissions', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(frames(new Error("ours"))).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
