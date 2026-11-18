import type { Node } from 'typescript/ast';
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renderLocalInput } from '../src/compiler/render-local-inputs.ts';
import { isTypeOnly } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const DATE_TEXT = 'writes a date as text of the time zone where it runs';

/**
 * A tag read through a class (statics, inherited members) or through `this` or `super` is not
 * followed: a Date it is given may be written as text there (`String(date)`,
 * `String.raw(strings, ...values)`), so the render is refused. A tag the code shows, and a
 * template with no Date in it, stay taken.
 */
const CASES = [
  {
    id: 'class-static-method-String-call',
    source: `class T{static text(_s:TemplateStringsArray,d:unknown){return String(d);}}export function Widget(){const date=new Date(0);return <p>{T.text\`\${date}\`}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'class-static-wrapper-of-String-raw',
    source: `class T{static raw(s:TemplateStringsArray,...v:unknown[]){return String.raw(s,...v);}}export function Widget(){const date=new Date(0);return <p>{T.raw\`\${date}\`}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'class-static-field-holding-String-raw',
    source: `class T{static raw=String.raw;}export function Widget(){const date=new Date(0);return <p>{T.raw\`\${date}\`}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'class-static-method-toDateString',
    source: `class Fmt{static day(_s:TemplateStringsArray,d:Date){return d.toDateString();}}export function Widget(){const date=new Date(0);return <p>{Fmt.day\`\${date}\`}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'class-static-method-utc-only-is-refused-coarsely',
    source: `class Fmt{static iso(_s:TemplateStringsArray,d:Date){return d.toISOString();}}export function Widget(){const date=new Date(0);return <p>{Fmt.iso\`\${date}\`}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'class-static-arrow-property',
    source: `class T{static text=(_s:TemplateStringsArray,d:unknown)=>String(d);}export function Widget(){const date=new Date(0);return <p>{T.text\`\${date}\`}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'class-static-taken-apart-by-pattern',
    source: `class T{static text(_s:TemplateStringsArray,d:unknown){return String(d);}}const {text:tag}=T;export function Widget(){const date=new Date(0);return <p>{tag\`\${date}\`}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'class-static-inherited',
    source: `class B{static text(_s:TemplateStringsArray,d:unknown){return String(d);}}class T extends B{}export function Widget(){const date=new Date(0);return <p>{T.text\`\${date}\`}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'class-expression-static',
    source: `const T=class{static text(_s:TemplateStringsArray,d:unknown){return String(d);}};export function Widget(){const date=new Date(0);return <p>{T.text\`\${date}\`}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'class-returned-by-a-function',
    source: `class T{static text(_s:TemplateStringsArray,d:unknown){return String(d);}}function pick(){return T;}export function Widget(){const date=new Date(0);return <p>{pick().text\`\${date}\`}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'this-method-of-a-class',
    source: `class T{text(_s:TemplateStringsArray,d:unknown){return String(d);}run(){const date=new Date(0);return this.text\`\${date}\`;}}export function Widget(){return <p>{new T().run()}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'this-method-of-an-object-literal',
    source: `const o={text(_s:TemplateStringsArray,d:unknown){return String(d);},run(){const date=new Date(0);return this.text\`\${date}\`;}};export function Widget(){return <p>{o.run()}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'this-helper-called-with-the-date-by-a-tag-body',
    source: `const o={pad(d:unknown){return String(d);},tag(_s:TemplateStringsArray,d:Date){return this.pad(d);}};export function Widget(){const date=new Date(0);return <p>{o.tag\`\${date}\`}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'instance-of-a-class-was-refused-pin',
    source: `class T{text(_s:TemplateStringsArray,d:unknown){return String(d);}}export function Widget(){const date=new Date(0);return <p>{new T().text\`\${date}\`}</p>;}`,
    local: DATE_TEXT,
  },
  {
    id: 'class-beside-a-utc-function-tag-pin',
    source: `class T{static n=1;}const iso=(_s:TemplateStringsArray,d:Date)=>d.toISOString();export function Widget(){const date=new Date(0);return <p>{String(T.n)}{iso\`\${date}\`}</p>;}`,
    local: undefined,
  },
  {
    id: 'bound-utc-tag-pin',
    source: `export function Widget(){const iso=((_s:TemplateStringsArray,d:Date)=>d.toISOString()).bind(null);const date=new Date(0);return <p>{iso\`\${date}\`}</p>;}`,
    local: undefined,
  },
  {
    id: 'function-declaration-utc-tag-pin',
    source: `function iso(_s:TemplateStringsArray,d:Date){return d.toISOString();}export function Widget(){const date=new Date(0);return <p>{iso\`\${date}\`}</p>;}`,
    local: undefined,
  },
  {
    id: 'object-literal-method-utc-tag-pin',
    source: `const tags={iso(_s:TemplateStringsArray,d:Date){return d.toISOString();}};export function Widget(){const date=new Date(0);return <p>{tags.iso\`\${date}\`}</p>;}`,
    local: undefined,
  },
  {
    id: 'class-static-tag-without-a-date-pin',
    source: `class T{static text(_s:TemplateStringsArray,d:unknown){return String(d);}}export function Widget(){return <p>{T.text\`\${'x'}\`}</p>;}`,
    local: undefined,
  },
  {
    id: 'this-tag-without-a-date-pin',
    source: `class T{text(_s:TemplateStringsArray,d:unknown){return String(d);}run(){return this.text\`\${1}\`;}}export function Widget(){return <p>{new T().run()}</p>;}`,
    local: undefined,
  },
] as const;

describe('a tag read through a class, this or super', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ source, local }) => {
    expect(firstLocalInput(api, source)).toBe(local);
  });
});

function firstLocalInput(api: API, source: string): string | undefined {
  using parsed = parseModule(api, 'render-class-this-tags.tsx', source);
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
