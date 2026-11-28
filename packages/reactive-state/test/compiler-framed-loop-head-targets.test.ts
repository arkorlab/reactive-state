import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * The target a `for-of` or `for-in` head assigns each value to is evaluated on every pass, with what
 * its computed keys read: a spread there of a collection whose iterating method the statement before
 * the loop replaced is read after what the body does, which may replace the method again. Only the
 * iterable, which runs once, is read right after that statement.
 */
const BEFORE =
  "const values=new Map<string,{stack?:string}>([['k',{stack:'fixed'}]]);const holder:Record<string,number>={};values.values=()=>[{stack:'fixed'}].values();";
const KEY = "[...values.values()][0]!.stack??''";
const AFTER = 'return Object.keys(holder)[0];';

const CASES = [
  {
    id: 'for-of-head-target-replaced-again-in-body',
    source: `function frames(error:Error){${BEFORE}for(holder[${KEY}] of [1,2]){values.values=()=>[error].values();}${AFTER}}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'for-in-head-target-replaced-again-in-body',
    source: `function frames(error:Error){${BEFORE}for(holder[${KEY}] in {a:1,b:2}){values.values=()=>[error].values();}${AFTER}}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  // Refused: nothing in the loop replaces the method again, but the head's target is not read as the
  // statement before the loop leaves it; no more is asked of a replacement than that.
  {
    id: 'for-of-head-target-replaced-before-loop-only',
    source: `function frames(error:Error){void error;${BEFORE}for(holder[${KEY}] of [1,2]){holder.x=1;}${AFTER}}`,
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'for-of-head-target-without-spread-quiet',
    source: `function frames(error:Error){${BEFORE}for(holder['key'] of [1,2]){values.values=()=>[error].values();}${AFTER}}`,
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'for-of-iterable-spread-replaced-before-loop-quiet',
    source: `function frames(error:Error){void error;${BEFORE}for(holder.key of [...values.values()].map((each)=>each.stack?.length??0)){holder.x=1;}${AFTER}}`,
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('replaced collection iteration read in the head of a loop', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'loop-head-targets.ts', source);
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

describe('shared loop head targets', () => {
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
