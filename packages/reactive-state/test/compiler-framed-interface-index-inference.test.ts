import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'explicit-string-error',
    source:
      'type Data={stack:string};type Value<T>=T extends {[key:string]:infer V}?V:Data;type Numeric<T>=T extends {[key:number]:infer V}?V:Data;interface Bag{[key:string]:Error}type Selected=Value<Bag>;function frames(error:Selected){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'generic-actual-error',
    source:
      'type Data={stack:string};type Value<T>=T extends {[key:string]:infer V}?V:Data;type Numeric<T>=T extends {[key:number]:infer V}?V:Data;interface Bag<T>{[key:string]:T}type Selected=Value<Bag<Error>>;function frames(error:Selected){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'generic-default-error',
    source:
      'type Data={stack:string};type Value<T>=T extends {[key:string]:infer V}?V:Data;type Numeric<T>=T extends {[key:number]:infer V}?V:Data;interface Bag<T=Error>{[key:string]:T}type Selected=Value<Bag>;function frames(error:Selected){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'inherited-generic-error',
    source:
      'type Data={stack:string};type Value<T>=T extends {[key:string]:infer V}?V:Data;type Numeric<T>=T extends {[key:number]:infer V}?V:Data;interface Parent<T>{[key:string]:T}interface Bag extends Parent<Error>{}type Selected=Value<Bag>;function frames(error:Selected){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'merged-explicit-error',
    source:
      'type Data={stack:string};type Value<T>=T extends {[key:string]:infer V}?V:Data;type Numeric<T>=T extends {[key:number]:infer V}?V:Data;interface Bag{[key:string]:Error}interface Bag{failure:Error}type Selected=Value<Bag>;function frames(error:Selected){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'explicit-number-error',
    source:
      'type Data={stack:string};type Value<T>=T extends {[key:string]:infer V}?V:Data;type Numeric<T>=T extends {[key:number]:infer V}?V:Data;interface Bag{[key:number]:Error}type Selected=Numeric<Bag>;function frames(error:Selected){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'string-covers-number',
    source:
      'type Data={stack:string};type Value<T>=T extends {[key:string]:infer V}?V:Data;type Numeric<T>=T extends {[key:number]:infer V}?V:Data;interface Bag{[key:string]:Error}type Selected=Numeric<Bag>;function frames(error:Selected){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'named-only-interface',
    source:
      'type Data={stack:string};type Value<T>=T extends {[key:string]:infer V}?V:Data;type Numeric<T>=T extends {[key:number]:infer V}?V:Data;interface Bag{failure:Error}type Selected=Value<Bag>;function frames(error:Selected){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'number-does-not-cover-string',
    source:
      'type Data={stack:string};type Value<T>=T extends {[key:string]:infer V}?V:Data;type Numeric<T>=T extends {[key:number]:infer V}?V:Data;interface Bag{[key:number]:Error}type Selected=Value<Bag>;function frames(error:Selected){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'explicit-string-data',
    source:
      'type Data={stack:string};type Value<T>=T extends {[key:string]:infer V}?V:Data;type Numeric<T>=T extends {[key:number]:infer V}?V:Data;interface Bag{[key:string]:Data}type Selected=Value<Bag>;function frames(error:Selected){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'generic-actual-data',
    source:
      'type Data={stack:string};type Value<T>=T extends {[key:string]:infer V}?V:Data;type Numeric<T>=T extends {[key:number]:infer V}?V:Data;interface Bag<T=Error>{[key:string]:T}type Selected=Value<Bag<Data>>;function frames(error:Selected){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'inherited-generic-data',
    source:
      'type Data={stack:string};type Value<T>=T extends {[key:string]:infer V}?V:Data;type Numeric<T>=T extends {[key:number]:infer V}?V:Data;interface Parent<T=Error>{[key:string]:T}interface Bag extends Parent<Data>{}type Selected=Value<Bag>;function frames(error:Selected){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'literal-implicit-index-error',
    source:
      'type Data={stack:string};type Value<T>=T extends {[key:string]:infer V}?V:Data;type Numeric<T>=T extends {[key:number]:infer V}?V:Data;type Bag={failure:Error};type Selected=Value<Bag>;function frames(error:Selected){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'literal-implicit-index-data',
    source:
      'type Data={stack:string};type Value<T>=T extends {[key:string]:infer V}?V:Data;type Numeric<T>=T extends {[key:number]:infer V}?V:Data;type Bag={failure:Data};type Selected=Value<Bag>;function frames(error:Selected){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'alias-generic-error',
    source:
      'type Data={stack:string};type Value<T>=T extends {[key:string]:infer V}?V:Data;type Numeric<T>=T extends {[key:number]:infer V}?V:Data;type Alias<T>=Bag<T>;interface Bag<T>{[key:string]:T}type Selected=Value<Alias<Error>>;function frames(error:Selected){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'inherited-default-error',
    source:
      'type Data={stack:string};type Value<T>=T extends {[key:string]:infer V}?V:Data;type Numeric<T>=T extends {[key:number]:infer V}?V:Data;interface Parent<T=Error>{[key:string]:T}interface Bag extends Parent{}type Selected=Value<Bag>;function frames(error:Selected){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'own-narrower-index-data',
    source:
      'type Data={stack:string};type Value<T>=T extends {[key:string]:infer V}?V:Data;type Numeric<T>=T extends {[key:number]:infer V}?V:Data;interface Parent{[key:string]:Error|Data}interface Bag extends Parent{[key:string]:Data}type Selected=Value<Bag>;function frames(error:Selected){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'inherited-number-precedence-data',
    source:
      'type Data={stack:string};type Value<T>=T extends {[key:string]:infer V}?V:Data;type Numeric<T>=T extends {[key:number]:infer V}?V:Data;interface Parent{[key:number]:Data}interface Bag extends Parent{[key:string]:Error|Data}type Selected=Numeric<Bag>;function frames(error:Selected){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'local-error-shadow-data',
    source:
      'type Data={stack:string};type Value<T>=T extends {[key:string]:infer V}?V:Data;type Numeric<T>=T extends {[key:number]:infer V}?V:Data;class Error{stack="fixed"}interface Bag{[key:string]:Error}type Selected=Value<Bag>;function frames(error:Selected){return error.stack;}',
    invocation: 'frames(new Error())',
    reader: false,
    refused: false,
  },
];

describe('interface index inference readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-error-observations.ts', source);
    const pending: Node[] = [parsed.sourceFile];
    let found = false;
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (framedRead(node) !== undefined) found = true;
      node.forEachChild((child) => {
        pending.push(child);
      });
    }

    expect(found).toBe(reader);
  });
});

describe('interface index inference admissions', () => {
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
