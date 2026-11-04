import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Named merged members shadow heritage while covering index signatures keep inherited names. */
const CASES = [
  {
    id: 'merged-interface-named-data-override',
    source:
      'type Data={stack:string};interface Base{failure:Error|Data}interface Bag extends Base{}interface Bag{failure:Data}type Failure=Bag["failure"];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'merged-interface-named-data-first',
    source:
      'type Data={stack:string};interface Base{failure:Error|Data}interface Bag{failure:Data}interface Bag extends Base{}type Failure=Bag["failure"];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'merged-interface-generic-actual-data',
    source:
      'type Data={stack:string};interface Base<T>{failure:Error|T}interface Bag<T> extends Base<T>{}interface Bag<T>{failure:T}type Failure=Bag<Data>["failure"];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'merged-interface-generic-default-data',
    source:
      'type Data={stack:string};interface Base<T>{failure:Error|T}interface Bag<T=Data> extends Base<T>{}interface Bag<T>{failure:T}type Failure=Bag["failure"];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'merged-interface-computed-name-data',
    source:
      'type Data={stack:string};interface Base{failure:Error|Data}interface Bag extends Base{}interface Bag{["failure"]:Data}type Failure=Bag["failure"];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'merged-interface-numeric-name-data',
    source:
      'type Data={stack:string};interface Base{0:Error|Data}interface Bag extends Base{}interface Bag{[0]:Data}type Failure=Bag[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'merged-interface-getter-data',
    source:
      'type Data={stack:string};interface Base{failure:Error|Data}interface Bag extends Base{}interface Bag{get failure():Data}type Failure=Bag["failure"];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'merged-interface-same-declaration-data-pin',
    source:
      'type Data={stack:string};interface Base{failure:Error|Data}interface Bag extends Base{failure:Data}type Failure=Bag["failure"];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'merged-interface-named-error-pin',
    source:
      'type Data={stack:string};interface Base{failure:Error|Data}interface Bag extends Base{}interface Bag{failure:Error}type Failure=Bag["failure"];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'merged-interface-inherited-error-pin',
    source:
      'type Data={stack:string};interface Base{failure:Error}interface Bag extends Base{}interface Bag{}type Failure=Bag["failure"];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'merged-interface-unrelated-member-error-pin',
    source:
      'type Data={stack:string};interface Base{failure:Error}interface Bag extends Base{}interface Bag{other:Data}type Failure=Bag["failure"];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'merged-interface-string-index-inherits-named-error-pin',
    source:
      'type Data={stack:string};interface Base{failure:Error}interface Bag extends Base{}interface Bag{[key:string]:{stack?:string}}type Failure=Bag["failure"];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'merged-interface-number-index-inherits-named-error-pin',
    source:
      'type Data={stack:string};interface Base{0:Error}interface Bag extends Base{}interface Bag{[key:number]:{stack?:string}}type Failure=Bag[0];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'merged-interface-index-only-error-pin',
    source:
      'type Data={stack:string};interface Bag{[key:string]:Error}interface Bag{}type Failure=Bag["failure"];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'merged-interface-index-only-data-pin',
    source:
      'type Data={stack:string};interface Bag{[key:string]:Data}interface Bag{}type Failure=Bag["failure"];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'merged-interface-explicit-data-over-index-pin',
    source:
      'type Data={stack:string};interface Bag{[key:string]:Error|Data}interface Bag{failure:Data}type Failure=Bag["failure"];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'merged-interface-inherited-union-error-pin',
    source:
      'type Data={stack:string};interface Base{failure:Error|Data}interface Bag extends Base{}interface Bag{other:Data}type Failure=Bag["failure"];function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new globalThis.Error("ours"))',
    refused: true,
  },
  {
    id: 'merged-interface-generic-shadow-data',
    source:
      'type Data={stack:string};interface Base<T>{failure:Error|T}interface Bag<T> extends Base<T>{}interface Bag<T>{failure:T}type Chosen=Bag<Data>;type Failure=Chosen["failure"];function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
];

describe('merged interface override readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'merged-interface-overrides.ts', source);
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

describe('shared merged interface override admissions', () => {
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
