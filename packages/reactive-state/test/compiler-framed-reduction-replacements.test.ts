import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A native reducer returns what its body writes into its returned parameter, not only its input. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reduce-replacement-review',
    source:
      'function frames(error:Error){return[0].reduce((acc:{stack?:string})=>{const ignored=(acc=error);return acc;},{stack:"fixed"}).stack;}',
    refused: true,
  },
  {
    id: 'reduce-replacement-statement',
    source:
      'function frames(error:Error){return[0].reduce((acc:{stack?:string})=>{acc=error;return acc;},{stack:"fixed"}).stack;}',
    refused: true,
  },
  {
    id: 'reduce-replacement-words',
    source:
      'function frames(error:Error){return[0].reduce((acc:{message?:string})=>{acc=error;return acc;},{message:"fixed"}).message;}',
    refused: true,
  },
  {
    id: 'reduce-right-replacement',
    source:
      'function frames(error:Error){return[0].reduceRight((acc:{stack?:string})=>{acc=error;return acc;},{stack:"fixed"}).stack;}',
    refused: true,
  },
  {
    id: 'reduce-element-replacement',
    source:
      'function frames(error:Error){return([{stack:"fixed"}]as{stack?:string}[]).reduce((accumulator:{stack?:string},value:{stack?:string})=>{const ignored=(value=error);return value;},{stack:"fixed"}).stack;}',
    refused: true,
  },
  {
    id: 'reduce-replacement-data-pin',
    source:
      'function frames(error:Error){return[0].reduce((acc:{stack?:string})=>{const ignored=(acc={stack:"other"});return acc;},{stack:"fixed"}).stack;}',
    refused: false,
  },
  {
    id: 'reduce-replacement-effect-pin',
    source:
      'function frames(error:Error){return[0].reduce((acc:{stack?:string})=>{acc=error;Object.assign(acc,{stack:"fixed"});return acc;},{stack:"fixed"}).stack;}',
    refused: false,
  },
  {
    id: 'reduce-replacement-saved-pin',
    source:
      'function frames(error:Error){const result=[0].reduce((acc:{stack?:string})=>{acc=error;return acc;},{stack:"fixed"});Object.assign(result,{stack:"fixed"});return result.stack;}',
    refused: false,
  },
  {
    id: 'reduce-replacement-local-words-pin',
    source:
      'function frames(error:Error){return[0].reduce((acc:{message?:string})=>{acc=new Error("fixed");return acc;},{message:"fixed"}).message;}',
    refused: false,
  },
  {
    id: 'reduce-reverse-data-write-pin',
    source:
      'function frames(error:Error){return[0].reduce((acc:Error|{stack:string})=>{const ignored=(acc={stack:"fixed"});return acc;},error as Error|{stack:string}).stack;}',
    refused: true,
  },
];

describe('reducer parameter replacement readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'reduction-replacements.ts', source);
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

describe('shared reducer parameter replacement admissions', () => {
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
