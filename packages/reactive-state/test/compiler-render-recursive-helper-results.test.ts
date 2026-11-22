import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renderLocalInput } from '../src/compiler/render-local-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DATE_TEXT = 'writes a date as text of the time zone where it runs';

const VALUE = '(_s:TemplateStringsArray,value:unknown)=>';
const OPEN = '${';
const ONE = `tag\`${OPEN}new Date(0)}\``;

/**
 * A helper of the file that calls itself answers the Date its returns make of the parameters a call
 * hands one. A call of itself that hands the Date to another parameter than the outer call did is
 * another question, asked once for each set of parameters (only a call that hands the same ones
 * again is cut), and a helper that returns a call of itself, past a conditional or a logical
 * operator, is taken to answer the Date, as the walk does not follow the path of the recursion: a
 * recursion that ends in a number but is returned as it is refuses, one that adds to the call or
 * passes the Date on without returning the call does not. The same holds for helpers whose returns
 * call one another back (two, or a ring of three), and a question that meets a function again with
 * an overlapping set of parameters keeps the assumptions of the one in hand.
 */
const CASES = [
  {
    id: 'recursion-passing-the-date-to-the-other-parameter',
    tag: `${VALUE}{function move(a:unknown,b:unknown):unknown{if(a)return move(null,a);return b;}return String(move(value,null));}`,
    local: DATE_TEXT,
  },
  {
    id: 'recursion-swapping-the-parameters',
    tag: `${VALUE}{const pick=(a:unknown,b:unknown):unknown=>(a?a:pick(b,a));return String(pick(null,value));}`,
    local: DATE_TEXT,
  },
  {
    id: 'recursion-rotating-three-parameters',
    tag: `${VALUE}{function turn(a:unknown,b:unknown,c:unknown,n:number):unknown{return n===0?c:turn(c,a,b,n-1);}return String(turn(value,null,null,2));}`,
    local: DATE_TEXT,
  },
  {
    id: 'mutual-recursion-passing-the-date-on',
    tag: `${VALUE}{function ping(a:unknown,b:unknown):unknown{return a?pong(b,a):b;}function pong(a:unknown,b:unknown):unknown{return a?ping(b,a):b;}return String(ping(value,null));}`,
    local: DATE_TEXT,
  },
  {
    id: 'mutual-recursion-meeting-again-with-an-overlapping-set',
    tag: `${VALUE}{function pick(a:unknown,_b:unknown,n:number):unknown{return n?relay(a,n-1):a;}function relay(a:unknown,n:number):unknown{return pick(a,a,n);}return String(pick(value,null,0));}`,
    local: DATE_TEXT,
  },
  {
    id: 'mutual-recursion-meeting-again-in-a-ring-of-three',
    tag: `${VALUE}{function pick(a:unknown,_b:unknown,n:number):unknown{return n?first(a,n-1):a;}function first(a:unknown,n:number):unknown{return second(a,n);}function second(a:unknown,n:number):unknown{return pick(a,a,n);}return String(pick(value,null,0));}`,
    local: DATE_TEXT,
  },
  {
    id: 'mutual-recursion-meeting-again-through-a-local',
    tag: `${VALUE}{function pick(a:unknown,_b:unknown,n:number):unknown{if(n){const answer=relay(a,n-1);return answer;}return a;}function relay(a:unknown,n:number):unknown{return pick(a,a,n);}return String(pick(value,null,0));}`,
    local: DATE_TEXT,
  },
  {
    id: 'mutual-recursion-meeting-again-in-arrow-constants',
    tag: `${VALUE}{const pick=(a:unknown,_b:unknown,n:number):unknown=>(n?relay(a,n-1):a);const relay=(a:unknown,n:number):unknown=>pick(a,a,n);return String(pick(value,null,0));}`,
    local: DATE_TEXT,
  },
  {
    id: 'mutual-recursion-met-again-inside-an-array-element',
    tag: `${VALUE}{function pick(a:unknown,_b:unknown,n:number):unknown{return n?[relay(a,n-1)][0]:a;}function relay(a:unknown,n:number):unknown{return pick(a,a,n);}return String(pick(value,null,0));}`,
    local: DATE_TEXT,
  },
  {
    id: 'mutual-recursion-adding-to-the-call-pin',
    tag: `${VALUE}{function pick(a:unknown,_b:unknown,n:number):number{return n?relay(a,n-1)+1:0;}function relay(a:unknown,n:number):number{return pick(a,a,n)+1;}return String(pick(value,null,2));}`,
    local: undefined,
  },
  {
    id: 'helpers-calling-one-another-without-a-cycle-pin',
    tag: `${VALUE}{const outer=(d:unknown)=>inner(d);const inner=(d:unknown)=>(d as Date).getTime();return String(outer(value));}`,
    local: undefined,
  },
  {
    id: 'recursion-returning-the-parameter-it-is-handed-pin',
    tag: `${VALUE}{const same=(d:unknown,n:number):unknown=>(n===0?d:same(d,n-1));return String(same(value,3));}`,
    local: DATE_TEXT,
  },
  {
    id: 'recursion-passing-the-date-and-returning-a-number-pin',
    tag: `${VALUE}{const count=(d:unknown,n:number):number=>(n===0?0:count(d,n-1)+1);return String(count(value,3));}`,
    local: undefined,
  },
  {
    id: 'recursion-returned-directly-and-ending-in-a-number-is-refused-pin',
    tag: `${VALUE}{function move(a:unknown,b:unknown):number{if(a)return move(null,a);return 0;}return String(move(value,null));}`,
    local: DATE_TEXT,
  },
  {
    id: 'mutual-recursion-returned-directly-and-ending-in-numbers-is-refused-pin',
    tag: `${VALUE}{function even(d:unknown,n:number):number{return n===0?1:odd(d,n-1);}function odd(d:unknown,n:number):number{return n===0?0:even(d,n-1);}return String(even(value,4));}`,
    local: DATE_TEXT,
  },
  {
    id: 'recursive-callback-handed-to-flatMap-pin',
    tag: `(_s:TemplateStringsArray,...values:unknown[])=>{const flat=(item:unknown):unknown[]=>(Array.isArray(item)?item.flatMap(flat):[1]);return String(values.flatMap(flat));}`,
    local: undefined,
  },
] as const;

describe('the answer of a helper of the file that calls itself', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ tag, local }) => {
    const source = `export function Widget(){const tag=${tag};return <p>{${ONE}}</p>;}`;

    expect(firstLocalInput(api, source)).toBe(local);
  });
});

function firstLocalInput(api: API, source: string): string | undefined {
  using parsed = parseModule(api, 'render-recursive-helper-results.tsx', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    const found = renderLocalInput(node);
    if (found !== undefined) return found;
    const children: Node[] = [];
    node.forEachChild((child) => {
      children.push(child);
    });
    pending.push(...children.toReversed());
  }
  return undefined;
}
