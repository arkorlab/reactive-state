import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renderLocalInput } from '../src/compiler/render-local-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DATE_TEXT = 'writes a date as text of the time zone where it runs';

const VALUE = '(_s:TemplateStringsArray,value:unknown)=>';
const REST = '(_s:TemplateStringsArray,...values:unknown[])=>';
const OPEN = '${';
const ONE = `tag\`${OPEN}new Date(0)}\``;
const RECORD = 'const record:Record<string,string>={};';

/**
 * A Date used as a property key is converted to a string, which for a Date is the text of the time
 * zone where it runs: `record[date] = 'ok'` creates a key of that text, and a read, a deletion, an
 * `in` test and a computed key of an object or a pattern ask for it. The conversion happens however
 * the member is used, so the key is read apart from the receiver. A number or text made of the Date
 * (`getTime()`, `toISOString()`), a literal key and an index a callback is handed are not Dates.
 */
const CASES = [
  {
    id: 'key-written',
    tag: `${VALUE}{${RECORD}record[value as string]='ok';return Object.keys(record)[0];}`,
    local: DATE_TEXT,
  },
  {
    id: 'key-read',
    tag: `${VALUE}{${RECORD}return record[value as string];}`,
    local: DATE_TEXT,
  },
  {
    id: 'key-deleted',
    tag: `${VALUE}{${RECORD}delete record[value as string];return 'x';}`,
    local: DATE_TEXT,
  },
  {
    id: 'key-incremented',
    tag: `${VALUE}{const counts:Record<string,number>={};counts[value as string]=(counts[value as string]??0)+1;return 'x';}`,
    local: DATE_TEXT,
  },
  {
    id: 'key-tested-with-in',
    tag: `${VALUE}{${RECORD}return String((value as string) in record);}`,
    local: DATE_TEXT,
  },
  {
    id: 'key-of-an-object-literal',
    tag: `${VALUE}({[value as string]:1})`,
    local: DATE_TEXT,
  },
  {
    id: 'key-taken-apart-by-a-pattern',
    tag: `${VALUE}{${RECORD}const {[value as string]:found}=record;return found;}`,
    local: DATE_TEXT,
  },
  {
    id: 'key-of-a-rest-substitution',
    tag: `${REST}{${RECORD}return record[values[0] as string];}`,
    local: DATE_TEXT,
  },
  {
    id: 'key-kept-under-a-name',
    tag: `${VALUE}{${RECORD}const key=value as string;return record[key];}`,
    local: DATE_TEXT,
  },
  {
    id: 'key-chosen-by-a-condition',
    tag: `${VALUE}{${RECORD}return record[Math.random()>0.5?(value as string):'x'];}`,
    local: DATE_TEXT,
  },
  {
    id: 'key-of-a-grouping-callback',
    tag: `${REST}{${RECORD}values.forEach((each)=>{record[each as string]='x';});return 'x';}`,
    local: DATE_TEXT,
  },
  {
    id: 'key-of-a-literal-pin',
    tag: `${VALUE}{${RECORD}return record['key']+String((value as Date).getTime());}`,
    local: undefined,
  },
  {
    id: 'key-made-of-the-time-pin',
    tag: `${VALUE}{${RECORD}return record[String((value as Date).getTime())];}`,
    local: undefined,
  },
  {
    id: 'key-made-of-the-iso-text-pin',
    tag: `${VALUE}{${RECORD}record[(value as Date).toISOString()]='ok';return 'x';}`,
    local: undefined,
  },
  {
    id: 'index-a-callback-is-handed-pin',
    tag: `${REST}{const list=['a','b'];return values.map((_each,index)=>list[index]).join('');}`,
    local: undefined,
  },
  {
    id: 'index-of-the-substitutions-pin',
    tag: `${REST}String((values[0] as Date).getTime())+String(values.length)`,
    local: undefined,
  },
  {
    id: 'number-key-from-the-time-pin',
    tag: `${VALUE}{const list=[1,2,3];return String(list[(value as Date).getTime()%3]);}`,
    local: undefined,
  },
  {
    id: 'text-tested-with-in-pin',
    tag: `${VALUE}{${RECORD}return String('key' in record)+String((value as Date).getTime());}`,
    local: undefined,
  },
  {
    id: 'literal-keys-of-an-object-pin',
    tag: `${VALUE}({key:(value as Date).getTime()})`,
    local: undefined,
  },
] as const;

describe('a Date a tag uses as a property key', () => {
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
  using parsed = parseModule(api, 'render-date-property-keys.tsx', source);
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
