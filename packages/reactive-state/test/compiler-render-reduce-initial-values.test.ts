import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renderLocalInput } from '../src/compiler/render-local-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DATE_TEXT = 'writes a date as text of the time zone where it runs';

const REST = '(_s:TemplateStringsArray,...values:unknown[])=>';
const ONE_VALUE = '(_s:TemplateStringsArray,value:unknown)=>';
const ONE = `tag\`\${new Date(0)}\``;

/**
 * The accumulator a reduction's callback is handed holds what it was started from and what the
 * callback hands on to the next call, whatever the receiver holds: a Date a tag started it from,
 * written as text in the callback, is the text of the time zone where it runs, as is an element the
 * callback answers or an array it puts elements into. A sum, a count or a text built of times holds
 * no Date, and the receiver's elements reach the accumulator only through what the callback answers.
 */
const ROWS = [
  ...(['reduce', 'reduceRight'] as const).flatMap((method) => {
    return [
      {
        id: `${method}-started-from-a-date`,
        tag: `${ONE_VALUE}[0].${method}((total)=>String(total),value)`,
        local: DATE_TEXT,
      },
      {
        id: `${method}-started-from-a-date-written-in-a-template`,
        tag: `${ONE_VALUE}[0].${method}((total)=>\`\${total}\`,value)`,
        local: DATE_TEXT,
      },
      {
        id: `${method}-started-from-a-date-added-to-text`,
        tag: `${ONE_VALUE}[0].${method}((total)=>'at:'+total,value)`,
        local: DATE_TEXT,
      },
      {
        id: `${method}-started-from-a-date-in-a-named-callback`,
        tag: `${ONE_VALUE}{const text=(total:unknown)=>String(total);return [0].${method}(text,value);}`,
        local: DATE_TEXT,
      },
      {
        id: `${method}-started-from-a-substitution-of-a-rest-list`,
        tag: `${REST}values.${method}((latest)=>String(latest),values[0])`,
        local: DATE_TEXT,
      },
      {
        id: `${method}-started-from-a-substitution-in-a-named-callback`,
        tag: `${REST}{const text=(latest:unknown)=>String(latest);return values.${method}(text,values[0]);}`,
        local: DATE_TEXT,
      },
      {
        id: `${method}-keeping-the-latest-date-written-in-the-callback`,
        tag: `${REST}values.${method}((latest,each)=>{String(latest);return (each as Date)>(latest as Date)?each:latest;},values[0])`,
        local: DATE_TEXT,
      },
      {
        id: `${method}-answering-an-element-written-in-the-callback`,
        tag: `${REST}values.${method}((kept,each)=>{String(kept);return each;},null)`,
        local: DATE_TEXT,
      },
      {
        id: `${method}-collecting-the-elements-written-in-the-callback`,
        tag: `${REST}values.${method}((out,each)=>{String(out);out.push(each);return out;},[] as unknown[])`,
        local: DATE_TEXT,
      },
      {
        id: `${method}-started-from-a-date-reads-the-time-pin`,
        tag: `${ONE_VALUE}[0].${method}((total)=>(total as Date).getTime(),value)`,
        local: undefined,
      },
      {
        id: `${method}-summing-the-times-pin`,
        tag: `${REST}values.${method}((sum,each)=>sum+(each as Date).getTime(),0)`,
        local: undefined,
      },
      {
        id: `${method}-counting-and-writing-the-count-pin`,
        tag: `${REST}values.${method}((count)=>count+String(count).length,0)`,
        local: undefined,
      },
      {
        id: `${method}-building-text-of-times-pin`,
        tag: `${REST}values.${method}((text,each)=>text+(each as Date).toISOString(),'')`,
        local: undefined,
      },
      {
        id: `${method}-keeping-the-latest-by-its-time-pin`,
        tag: `${REST}values.${method}((latest,each)=>(each as Date).getTime()>(latest as Date).getTime()?each:latest,values[0])`,
        local: undefined,
      },
      {
        id: `${method}-started-from-text-and-writing-it-pin`,
        tag: `${REST}values.${method}((text)=>String(text),'x')`,
        local: undefined,
      },
      {
        id: `${method}-in-a-named-callback-summing-the-times-pin`,
        tag: `${REST}{const add=(sum:number,each:unknown)=>sum+(each as Date).getTime();return values.${method}(add,0);}`,
        local: undefined,
      },
    ];
  }),
  {
    id: 'reduce-answer-written-outside-the-callback-was-followed-pin',
    tag: `${ONE_VALUE}String([0].reduce((total)=>total,value))`,
    local: DATE_TEXT,
  },
  {
    id: 'reduce-without-an-initial-value-written-in-the-callback-was-followed-pin',
    tag: `${REST}values.reduce((total)=>String(total))`,
    local: DATE_TEXT,
  },
  {
    id: 'reduce-borrowed-started-from-a-date',
    tag: `${ONE_VALUE}Array.prototype.reduce.call([0],(total:unknown)=>String(total),value)`,
    local: DATE_TEXT,
  },
  {
    id: 'reduce-applied-started-from-a-date',
    tag: `${ONE_VALUE}[0].reduce.apply([0],[(total:unknown)=>String(total),value])`,
    local: DATE_TEXT,
  },
] as const;

describe('the accumulator of a reduction a tag starts from a Date', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(ROWS)('$id', ({ tag, local }) => {
    const source = `export function Widget(){const tag=${tag};return <p>{${ONE}}</p>;}`;

    expect(firstLocalInput(api, source)).toBe(local);
  });
});

function firstLocalInput(api: API, source: string): string | undefined {
  using parsed = parseModule(api, 'render-reduce-initial-values.tsx', source);
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
