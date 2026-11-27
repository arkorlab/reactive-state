import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A collection's own iterating method, replaced by the statement right before a spread, is read as
 * the replacement reads only where the spread runs once, right after that statement. A loop's
 * condition, update or unbraced body runs again after what the loop does, which may replace the
 * method again, so a spread there reads the collection as any reader would. A `for` initializer
 * and a `for-of` iterable run once, and a body's own block starts after its previous statement on
 * each pass.
 */
const CASES = [
  {
    id: 'while-condition-replaced-again-in-body',
    source:
      "function frames(error:Error){const values=new Map<string,{stack?:string}>([['k',{stack:'fixed'}]]);let seen='';let again=true;values.values=()=>[{stack:'fixed'}].values();while((seen=[...values.values()][0]!.stack??'')&&again){again=false;values.values=()=>[error].values();}return seen;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'for-condition-replaced-again-in-body',
    source:
      "function frames(error:Error){const values=new Map<string,{stack?:string}>([['k',{stack:'fixed'}]]);let seen='';let again=true;values.values=()=>[{stack:'fixed'}].values();for(;(seen=[...values.values()][0]!.stack??'')&&again;){again=false;values.values=()=>[error].values();}return seen;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'for-update-replaced-again-in-body',
    source:
      "function frames(error:Error){const values=new Map<string,{stack?:string}>([['k',{stack:'fixed'}]]);let seen='';let n=0;values.values=()=>[{stack:'fixed'}].values();for(;n<2;seen=[...values.values()][0]!.stack??'',n++){values.values=()=>[error].values();}return seen;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'set-while-condition-replaced-again-in-body',
    source:
      "function frames(error:Error){const values=new Set<{stack?:string}>([{stack:'fixed'}]);let seen='';let again=true;values[Symbol.iterator]=()=>[{stack:'fixed'}].values();while((seen=[...values][0]!.stack??'')&&again){again=false;values[Symbol.iterator]=()=>[error].values();}return seen;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unbraced-body-replaced-after-read',
    source:
      "function frames(error:Error){const values=new Map<string,{stack?:string}>([['k',{stack:'fixed'}]]);let seen='';let more=true;let first=true;values.values=()=>[{stack:'fixed'}].values();while(more)seen=([...values.values()][0]!.stack??'')+(more=first,first=false,values.values=()=>[error].values(),'');return seen;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  // Refused: nothing in the loop replaces the method again, but the condition is not read as the
  // statement before the loop leaves it; no more is asked of a replacement than that.
  {
    id: 'while-condition-replaced-before-loop-only',
    source:
      "function frames(error:Error){void error;const values=new Map<string,{stack?:string}>([['k',{stack:'fixed'}]]);let seen='';let again=true;values.values=()=>[{stack:'fixed'}].values();while((seen=[...values.values()][0]!.stack??'')&&again){again=false;}return seen;}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'replaced-data-straight-line-quiet',
    source:
      "function frames(error:Error){void error;const values=new Map<string,{stack?:string}>([['k',{stack:'fixed'}]]);values.values=()=>[{stack:'fixed'}].values();return [...values.values()][0]!.stack;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'for-of-iterable-replaced-quiet',
    source:
      "function frames(error:Error){void error;const values=new Map<string,{stack?:string}>([['k',{stack:'fixed'}]]);let seen='';values.values=()=>[{stack:'fixed'}].values();for(const each of [...values.values()]){seen=each.stack??'';}return seen;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'for-initializer-replaced-quiet',
    source:
      "function frames(error:Error){void error;const values=new Map<string,{stack?:string}>([['k',{stack:'fixed'}]]);values.values=()=>[{stack:'fixed'}].values();for(let seen=[...values.values()][0]!.stack??'';seen==='';){return seen;}return '';}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'braced-body-replaced-before-read-quiet',
    source:
      "function frames(error:Error){void error;const values=new Map<string,{stack?:string}>([['k',{stack:'fixed'}]]);let seen='';let n=0;while(n++<2){values.values=()=>[{stack:'fixed'}].values();seen=[...values.values()][0]!.stack??'';}return seen;}",
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

describe('replaced collection iteration read in a loop', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'loop-replaced-iteration.ts', source);
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

describe('shared loop replaced iteration results', () => {
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
