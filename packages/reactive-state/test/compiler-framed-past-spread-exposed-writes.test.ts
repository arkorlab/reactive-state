import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * What is written past a spread the compile cannot read, or at one of an array other code has
 * changed, is still copied: its value is known, only its position is not. For an array that was
 * changed, it is what the array was written with and what was written into its entries since:
 * `sources[0] = { inner: error }` replaces the entry the array was written with.
 */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly refused: boolean;
}

const BOX = 'const box:{inner?:{stack?:string}}={};';
const READ = 'return box.inner!.stack;';

const CASES: readonly Case[] = [
  {
    id: 'past-unread-spread-entry-zero-written',
    source: `function frames(error:Error,...unread:object[]){${BOX}const sources:object[]=[{other:1}];sources[0]={inner:error};Object.assign(box,...unread,...sources);${READ}}`,
    refused: true,
  },
  {
    id: 'past-unread-spread-entry-one-written',
    source: `function frames(error:Error,...unread:object[]){${BOX}const sources:object[]=[{other:1},{other:2}];sources[1]={inner:error};Object.assign(box,...unread,...sources);${READ}}`,
    refused: true,
  },
  {
    id: 'exposed-spread-entry-zero-written',
    source: `function frames(error:Error){${BOX}const sources:object[]=[{other:1}];sources[0]={inner:error};Object.assign(box,...sources);${READ}}`,
    refused: true,
  },
  {
    id: 'exposed-spread-entry-one-written',
    source: `function frames(error:Error){${BOX}const sources:object[]=[{other:1},{other:2}];sources[1]={inner:error};Object.assign(box,...sources);${READ}}`,
    refused: true,
  },
  {
    id: 'exposed-spread-entry-written-literal-after',
    source: `function frames(error:Error){${BOX}const sources:object[]=[{other:1},{other:2}];sources[1]={inner:error};Object.assign(box,...sources,{other:3});${READ}}`,
    refused: true,
  },
  {
    id: 'past-unread-spread-entry-written-in-a-loop',
    source: `function frames(error:Error,...unread:object[]){${BOX}const sources:object[]=[{other:1}];let n=0;do{Object.assign(box,...unread,...sources);}while((sources[0]={inner:error},n++<1));${READ}}`,
    refused: true,
  },
  {
    id: 'past-unread-spread-written-original',
    source: `function frames(error:Error,...unread:object[]){${BOX}const sources:object[]=[{inner:error}];Object.assign(box,...unread,...sources);${READ}}`,
    refused: true,
  },
  {
    id: 'past-unread-spread-entry-written-data',
    source: `function frames(error:Error,...unread:object[]){void error;${BOX}const sources:object[]=[{other:1}];sources[0]={inner:{stack:'fixed'}};Object.assign(box,...unread,...sources);${READ}}`,
    refused: false,
  },
  {
    id: 'exposed-spread-entry-written-data',
    source: `function frames(error:Error){void error;${BOX}const sources:object[]=[{other:1},{other:2}];sources[1]={inner:{stack:'fixed'}};Object.assign(box,...sources);${READ}}`,
    refused: false,
  },
  // A property the array is given under another name is no entry: a spread never yields it.
  {
    id: 'exposed-spread-named-property-written-data',
    source: `function frames(error:Error){void error;${BOX}const sources:object[]&{meta?:{inner:Error}}=[{other:1}];sources['meta']={inner:error};Object.assign(box,...sources);return box.inner?.stack;}`,
    refused: false,
  },
  {
    id: 'past-unread-spread-named-property-written-data',
    source: `function frames(error:Error,...unread:object[]){void error;${BOX}const sources:object[]&{meta?:{inner:Error}}=[{other:1}];sources['meta']={inner:error};Object.assign(box,...unread,...sources);return box.inner?.stack;}`,
    refused: false,
  },
  {
    id: 'exposed-spread-non-canonical-index-written-data',
    source: `function frames(error:Error){void error;${BOX}const sources:object[]=[{other:1}];sources['-1']={inner:error};sources['01']={inner:error};sources[1.5]={inner:error};Object.assign(box,...sources);return box.inner?.stack;}`,
    refused: false,
  },
  {
    id: 'exposed-spread-canonical-string-index-written',
    source: `function frames(error:Error){${BOX}const sources:object[]=[{other:1},{other:2}];sources['1']={inner:error};Object.assign(box,...sources);${READ}}`,
    refused: true,
  },
  {
    id: 'exposed-spread-unknown-index-written',
    source: `function frames(error:Error,at:number){${BOX}const sources:object[]=[{other:1},{other:2}];sources[at]={inner:error};Object.assign(box,...sources);${READ}}`,
    refused: true,
  },
  // What an array method stores in the array is written into it as well.
  {
    id: 'past-unread-spread-entry-pushed',
    source: `function frames(error:Error,...unread:object[]){${BOX}const sources:object[]=[{other:1}];sources.push({inner:error});Object.assign(box,...unread,...sources);${READ}}`,
    refused: true,
  },
  {
    id: 'exposed-spread-entry-pushed',
    source: `function frames(error:Error){${BOX}const sources:object[]=[{other:1}];sources.push({inner:error});Object.assign(box,...sources);${READ}}`,
    refused: true,
  },
  {
    id: 'past-unread-spread-entry-unshifted',
    source: `function frames(error:Error,...unread:object[]){${BOX}const sources:object[]=[{other:1}];sources.unshift({inner:error});Object.assign(box,...unread,...sources);${READ}}`,
    refused: true,
  },
  {
    id: 'past-unread-spread-entry-spliced-in',
    source: `function frames(error:Error,...unread:object[]){${BOX}const sources:object[]=[{other:1},{other:2}];sources.splice(1,0,{inner:error});Object.assign(box,...unread,...sources);${READ}}`,
    refused: true,
  },
  {
    id: 'past-unread-spread-entries-filled',
    source: `function frames(error:Error,...unread:object[]){${BOX}const sources:object[]=[{other:1},{other:2}];sources.fill({inner:error});Object.assign(box,...unread,...sources);${READ}}`,
    refused: true,
  },
  {
    id: 'past-unread-spread-entry-pushed-in-a-loop',
    source: `function frames(error:Error,...unread:object[]){${BOX}const sources:object[]=[{other:1}];let n=0;do{Object.assign(box,...unread,...sources);}while((sources.push({inner:error}),n++<1));${READ}}`,
    refused: true,
  },
  {
    id: 'past-unread-spread-entry-pushed-data',
    source: `function frames(error:Error,...unread:object[]){void error;${BOX}const sources:object[]=[{other:1}];sources.push({inner:{stack:'fixed'}});Object.assign(box,...unread,...sources);${READ}}`,
    refused: false,
  },
  {
    id: 'past-unread-spread-entry-spliced-out-data',
    source: `function frames(error:Error,...unread:object[]){void error;${BOX}const sources:object[]=[{other:1},{other:2}];sources.splice(1,1);Object.assign(box,...unread,...sources);return box.inner?.stack;}`,
    refused: false,
  },
  {
    id: 'past-unread-spread-other-array-pushed-data',
    source: `function frames(error:Error,...unread:object[]){void error;${BOX}const sources:object[]=[{other:1}];const other:object[]=[];other.push({inner:error});Object.assign(box,...unread,...sources);return box.inner?.stack;}`,
    refused: false,
  },
  // Limits: what a spread of a list the compile cannot read pushes, and what a destructuring
  // assignment writes into an entry, are no write the compile follows.
  {
    id: 'past-unread-spread-entries-pushed-from-a-list-limit',
    source: `function frames(error:Error,more:object[],...unread:object[]){${BOX}const sources:object[]=[{other:1}];sources.push(...more);Object.assign(box,...unread,...sources);${READ}}`,
    refused: false,
  },
  {
    id: 'past-unread-spread-entry-written-by-a-pattern-limit',
    source: `function frames(error:Error,...unread:object[]){${BOX}const sources:object[]=[{other:1},{other:2}];[sources[1]]=[{inner:error}];Object.assign(box,...unread,...sources);${READ}}`,
    refused: false,
  },
];

describe('writes into an array spread past what the compile cannot read', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'past-spread-exposed-writes.ts', source);
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

describe('shared writes into an array spread past what the compile cannot read', () => {
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
