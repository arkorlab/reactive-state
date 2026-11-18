import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renderLocalInput } from '../src/compiler/render-local-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DATE_TEXT = 'writes a date as text of the time zone where it runs';

const REST = '(_s:TemplateStringsArray,...values:unknown[])=>';
const REST_DATES = '(_s:TemplateStringsArray,...values:Date[])=>';
const DATED = '(_s:TemplateStringsArray,date:Date)=>';
const IDENTITY = 'const identity=(value:unknown)=>value;';
const OR_NONE = "const orNone=(value:unknown)=>value??'-';";

/**
 * A function of the file a tag hands its Date, in a call or as a callback of `map`, `flatMap` or
 * `Array.from`, answers what its returns make of the parameter: the Date itself, or an array
 * that holds it, which the tag then writes as text. What it makes of the Date (`getTime()`,
 * `toISOString()`) and a constant answer nothing; a function the code does not show (an import)
 * was refused where it is given a Date, whatever it answers.
 */
const CASES = [
  {
    id: 'identity-in-String',
    pre: IDENTITY,
    tag: `${DATED}String(identity(date))`,
    local: DATE_TEXT,
  },
  {
    id: 'identity-in-a-template',
    pre: IDENTITY,
    tag: `${DATED}\`\${identity(date)}\``,
    local: DATE_TEXT,
  },
  {
    id: 'identity-added-to-text',
    pre: IDENTITY,
    tag: `${DATED}'at:'+identity(date)`,
    local: DATE_TEXT,
  },
  {
    id: 'default-with-nullish-coalescing',
    pre: OR_NONE,
    tag: `${DATED}\`\${orNone(date)}\``,
    local: DATE_TEXT,
  },
  {
    id: 'function-declaration-after-the-tag',
    pre: '',
    tag: `${DATED}String(show(date))`,
    post: 'function show(value:unknown){return value;}',
    local: DATE_TEXT,
  },
  {
    id: 'second-parameter-is-the-date',
    pre: 'const pick=(_label:string,value:unknown)=>value;',
    tag: `${DATED}String(pick('a',date))`,
    local: DATE_TEXT,
  },
  {
    id: 'first-parameter-is-the-date',
    pre: 'const first=(value:unknown,_label:string)=>value;',
    tag: `${DATED}String(first(date,'a'))`,
    local: DATE_TEXT,
  },
  {
    id: 'returned-through-a-local',
    pre: 'const through=(value:unknown)=>{const kept=value;return kept;};',
    tag: `${DATED}String(through(date))`,
    local: DATE_TEXT,
  },
  {
    id: 'returned-in-a-branch',
    pre: "const either=(value:unknown,flag:boolean)=>{if(flag){return 'x';}return value;};",
    tag: `${DATED}String(either(date,false))`,
    local: DATE_TEXT,
  },
  {
    id: 'returned-in-an-array',
    pre: 'const wrap=(value:unknown)=>[value];',
    tag: `${DATED}String(wrap(date))`,
    local: DATE_TEXT,
  },
  {
    id: 'rest-parameter',
    pre: 'const head=(...items:unknown[])=>items[0];',
    tag: `${DATED}String(head(date))`,
    local: DATE_TEXT,
  },
  {
    id: 'two-helpers-in-a-row',
    pre: `${IDENTITY}${OR_NONE}`,
    tag: `${DATED}String(orNone(identity(date)))`,
    local: DATE_TEXT,
  },
  {
    id: 'a-function-that-calls-itself',
    pre: 'const down=(value:unknown,count:number):unknown=>count>0?down(value,count-1):value;',
    tag: `${DATED}String(down(date,2))`,
    local: DATE_TEXT,
  },
  {
    id: 'a-helper-called-by-a-helper',
    pre: `${IDENTITY}const twice=(value:unknown)=>identity(value);`,
    tag: `${DATED}String(twice(date))`,
    local: DATE_TEXT,
  },
  {
    id: 'map-with-a-named-callback',
    pre: IDENTITY,
    tag: `${REST}values.map(identity).join('')`,
    local: DATE_TEXT,
  },
  {
    id: 'map-with-a-default-callback',
    pre: OR_NONE,
    tag: `${REST}values.map(orNone).join('')`,
    local: DATE_TEXT,
  },
  {
    id: 'flatMap-with-a-named-callback',
    pre: IDENTITY,
    tag: `${REST}values.flatMap(identity).join('')`,
    local: DATE_TEXT,
  },
  {
    id: 'Array.from-with-a-named-callback',
    pre: IDENTITY,
    tag: `${REST}Array.from(values,identity).join('')`,
    local: DATE_TEXT,
  },
  {
    id: 'map-with-a-function-declaration',
    pre: '',
    tag: `${REST}values.map(show).join('')`,
    post: 'function show(value:unknown){return value;}',
    local: DATE_TEXT,
  },
  {
    id: 'alias-of-the-date-handed-twice',
    pre: 'const pair=(_first:unknown,second:unknown)=>second;',
    tag: `${DATED}{const copy=date;return String(pair(copy,copy));}`,
    local: DATE_TEXT,
  },
  {
    id: 'alias-read-after-a-helper-that-ignores-it',
    pre: 'const count=(_value:unknown)=>1;',
    tag: `${DATED}{const copy=date;return String([count(copy),copy]);}`,
    local: DATE_TEXT,
  },
  {
    id: 'alias-read-after-a-helper-that-answers-a-string',
    pre: 'const pair=(_first:unknown,second:unknown)=>second;',
    tag: `${DATED}{const copy=date;return String([pair(copy,'x'),copy]);}`,
    local: DATE_TEXT,
  },
  {
    id: 'alias-read-after-a-mapped-helper-that-ignores-it',
    pre: 'const count=(_value:unknown)=>1;',
    tag: `${DATED}{const copy=date;return String([[copy].map(count),copy]);}`,
    local: DATE_TEXT,
  },
  {
    id: 'destructured-length-of-an-array-pin',
    pre: 'const count=({length}:unknown[])=>length;',
    tag: `${DATED}String(count([date]))`,
    local: undefined,
  },
  {
    id: 'destructured-length-under-another-name-pin',
    pre: 'const count=({length:total}:unknown[])=>total;',
    tag: `${DATED}String(count([date]))`,
    local: undefined,
  },
  {
    id: 'destructured-member-of-an-object-pin',
    pre: 'const label=({name}:{name:string;when:unknown})=>name;',
    tag: `${DATED}String(label({name:'x',when:date}))`,
    local: undefined,
  },
  {
    id: 'array-pattern-parameter-answers-an-element',
    pre: 'const first=([head]:unknown[])=>head;',
    tag: `${DATED}String(first([date]))`,
    local: DATE_TEXT,
  },
  {
    id: 'array-pattern-with-a-rest',
    pre: 'const rest=([_head,...tail]:unknown[])=>tail;',
    tag: `${DATED}String(rest([1,date]))`,
    local: DATE_TEXT,
  },
  {
    id: 'array-pattern-nested-in-an-object-pattern-pin',
    pre: 'const inner=({items:[head]}:{items:unknown[]})=>head;',
    tag: `${DATED}String(inner({items:[date]}))`,
    local: undefined,
  },
  {
    id: 'variable-reassigned-through-a-helper',
    pre: IDENTITY,
    tag: `${DATED}{let value:unknown=date;value=identity(value);return String(value);}`,
    local: DATE_TEXT,
  },
  {
    id: 'variable-reassigned-through-a-helper-in-a-loop',
    pre: IDENTITY,
    tag: `${DATED}{let value:unknown=date;for(let turn=0;turn<3;turn+=1){value=identity(value);}return String(value);}`,
    local: DATE_TEXT,
  },
  {
    id: 'two-variables-reassigned-through-a-helper-from-each-other',
    pre: IDENTITY,
    tag: `${DATED}{let first:unknown=date;let second:unknown=first;first=identity(second);second=identity(first);return String(first);}`,
    local: DATE_TEXT,
  },
  {
    id: 'default-applied-to-a-variable-that-holds-the-date',
    pre: OR_NONE,
    tag: `${DATED}{let text:unknown=date;text=orNone(text);return \`\${text}\`;}`,
    local: DATE_TEXT,
  },
  {
    id: 'variable-of-a-string-reassigned-through-a-helper-pin',
    pre: IDENTITY,
    tag: `${DATED}{let value:unknown='x';value=identity(value);return String(value);}`,
    local: undefined,
  },
  {
    id: 'variable-of-the-time-reassigned-through-a-helper-pin',
    pre: IDENTITY,
    tag: `${DATED}{let value:unknown=date.getTime();value=identity(value);return String(value);}`,
    local: undefined,
  },
  {
    id: 'variable-reassigned-through-two-helpers-in-a-row-pin',
    pre: IDENTITY,
    tag: `${DATED}{let value:unknown=1;value=identity(identity(value));return String(value);}`,
    local: undefined,
  },
  {
    id: 'variable-handed-twice-to-a-helper-and-reassigned-pin',
    pre: 'const pair=(_first:unknown,second:unknown)=>second;',
    tag: `${DATED}{let value:unknown='x';value=pair(value,value);return String(value);}`,
    local: undefined,
  },
  {
    id: 'array-reassigned-through-a-mapped-helper-pin',
    pre: IDENTITY,
    tag: `${REST}{let list:unknown[]=[1];list=list.map(identity);return String(list);}`,
    local: undefined,
  },
  {
    id: 'array-reassigned-through-a-mapped-helper',
    pre: IDENTITY,
    tag: `${REST}{let list:unknown[]=values;list=list.map(identity);return String(list);}`,
    local: DATE_TEXT,
  },
  {
    id: 'inline-callback-was-followed-pin',
    pre: '',
    tag: `${REST}values.map((value)=>value).join('')`,
    local: DATE_TEXT,
  },
  {
    id: 'getTime-of-the-date-pin',
    pre: 'const stamp=(value:Date)=>value.getTime();',
    tag: `${DATED}String(stamp(date))`,
    local: undefined,
  },
  {
    id: 'iso-text-of-the-date-pin',
    pre: 'const iso=(value:Date)=>value.toISOString();',
    tag: `${DATED}String(iso(date))`,
    local: undefined,
  },
  {
    id: 'constant-answer-pin',
    pre: "const fixed=(_value:unknown)=>'fixed';",
    tag: `${DATED}String(fixed(date))`,
    local: undefined,
  },
  {
    id: 'array-of-the-time-pin',
    pre: 'const wrap=(value:Date)=>[value.getTime()];',
    tag: `${DATED}String(wrap(date))`,
    local: undefined,
  },
  {
    id: 'helper-not-given-the-date-pin',
    pre: IDENTITY,
    tag: `${DATED}String(identity('x'))`,
    local: undefined,
  },
  {
    id: 'imported-helper-was-refused-pin',
    pre: "import {format} from './format';",
    tag: `${DATED}String(format(date))`,
    local: DATE_TEXT,
  },
  {
    id: 'map-with-a-callback-that-makes-the-time-pin',
    pre: 'const stamp=(value:Date)=>value.getTime();',
    tag: `${REST_DATES}values.map(stamp).join(',')`,
    local: undefined,
  },
  {
    id: 'map-with-a-callback-that-makes-iso-text-pin',
    pre: 'const iso=(value:Date)=>value.toISOString();',
    tag: `${REST_DATES}values.map(iso).join(',')`,
    local: undefined,
  },
  {
    id: 'map-with-Number-pin',
    pre: '',
    tag: `${REST_DATES}values.map(Number).join(',')`,
    local: undefined,
  },
  {
    id: 'two-helpers-that-call-each-other-end-pin',
    pre: 'const ping=(value:unknown):unknown=>pong(value);const pong=(value:unknown):unknown=>ping(value);',
    tag: `${DATED}String(ping(date))`,
    local: undefined,
  },
] as const;

describe('a function of the file a tag hands its Date', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', (row) => {
    const post = 'post' in row ? row.post : '';
    const source = `${row.pre}export function Widget(){const tag=${row.tag};return <p>{tag\`a\${new Date(0)}b\`}</p>;}${post}`;

    expect(firstLocalInput(api, source)).toBe(row.local);
  });
});

function firstLocalInput(api: API, source: string): string | undefined {
  using parsed = parseModule(api, 'render-helper-results.tsx', source);
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
