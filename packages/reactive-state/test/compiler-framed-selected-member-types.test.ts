import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Selected declared fields retain read-accessor priority and written index domains. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly reader?: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'get-data-before-set-error',
    source:
      'type Data={stack:string};type Box={get failure():Data;set failure(value:Error|Data);};type Value=Box["failure"];function frames(error:Value){return error.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'get-data-after-set-error',
    source:
      'type Data={stack:string};type Box={set failure(value:Error|Data);get failure():Data;};type Value=Box["failure"];function frames(error:Value){return error.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'get-error-with-data-set',
    source:
      'type Data={stack:string};type Box={get failure():Error;set failure(value:Error|Data);};type Value=Box["failure"];function frames(error:Value){return error.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'setter-only-error-pin',
    source:
      'type Box={set failure(value:Error);};type Value=Box["failure"];function frames(error:Value){return error.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'setter-only-data-pin',
    source:
      'type Box={set failure(value:{stack:string});};type Value=Box["failure"];function frames(error:Value){return error.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'getter-only-data-pin',
    source:
      'type Box={get failure():{stack:string};};type Value=Box["failure"];function frames(error:Value){return error.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'getter-only-error-pin',
    source:
      'type Box={get failure():Error;};type Value=Box["failure"];function frames(error:Value){return error.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'computed-get-data',
    source:
      'type Data={stack:string};type Box={get ["failure"]():Data;set ["failure"](value:Error|Data);};type Value=Box["failure"];function frames(error:Value){return error.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'numeric-get-data',
    source:
      'type Data={stack:string};type Box={get 0():Data;set 0(value:Error|Data);};type Value=Box[0];function frames(error:Value){return error.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'interface-paired-data',
    source:
      'type Data={stack:string};interface Box{get failure():Data;set failure(value:Error|Data);}type Value=Box["failure"];function frames(error:Value){return error.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'interface-paired-error',
    source:
      'type Data={stack:string};interface Box{get failure():Error;set failure(value:Error|Data);}type Value=Box["failure"];function frames(error:Value){return error.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'generic-paired-data',
    source:
      'type Box<T>={get failure():T;set failure(value:Error|T);};type Value=Box<{stack:string}>["failure"];function frames(error:Value){return error.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'generic-paired-error',
    source:
      'type Box<T>={get failure():T;set failure(value:Error|T);};type Value=Box<Error>["failure"];function frames(error:Value){return error.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'default-paired-data',
    source:
      'type Box<T={stack:string}>={get failure():T;set failure(value:Error|T);};type Value=Box["failure"];function frames(error:Value){return error.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'nested-read-paired-data',
    source:
      'type Data={stack:string};type Box={get failure():{inner:Data};set failure(value:{inner:Error|Data});};type Value=Box["failure"]["inner"];function frames(error:Value){return error.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'paired-union-read-data',
    source:
      'type Data={stack:string};type Box={get first():Data;set first(value:Error|Data);get second():Data;set second(value:Error|Data);};type Value=Box["first"|"second"];function frames(error:Value){return error.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'string-symbol-domain-error',
    source:
      'type Bag={[key:string|symbol]:Error};type Value=Bag["failure"];function frames(error:Value){return error.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'symbol-string-domain-error',
    source:
      'type Bag={[key:symbol|string]:Error};type Value=Bag["failure"];function frames(error:Value){return error.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'number-symbol-domain-error',
    source:
      'type Bag={[key:number|symbol]:Error};type Value=Bag[0];function frames(error:Value){return error.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'string-number-domain-error',
    source:
      'type Bag={[key:string|number]:Error};type Value=Bag["failure"];function frames(error:Value){return error.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'all-three-domains-error',
    source:
      'type Bag={[key:string|number|symbol]:Error};type Value=Bag[1];function frames(error:Value){return error.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'parenthesized-domain-error',
    source:
      'type Bag={[key:(string|symbol)]:Error};type Value=Bag["failure"];function frames(error:Value){return error.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'alias-domain-error',
    source:
      'type Keys=string|symbol;type Bag={[key:Keys]:Error};type Value=Bag["failure"];function frames(error:Value){return error.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nested-alias-domain-error',
    source:
      'type First=number|symbol;type Keys=First;type Bag={[key:Keys]:Error};type Value=Bag[0];function frames(error:Value){return error.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'interface-union-domain-error',
    source:
      'interface Bag{[key:string|symbol]:Error}type Value=Bag["failure"];function frames(error:Value){return error.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'inherited-union-domain-error',
    source:
      'interface Base{[key:string|symbol]:Error}interface Bag extends Base{}type Value=Bag["failure"];function frames(error:Value){return error.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'generic-union-value-error',
    source:
      'type Bag<T>={[key:string|symbol]:T};type Value=Bag<Error>["failure"];function frames(error:Value){return error.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'default-union-value-error',
    source:
      'type Bag<T=Error>={[key:number|symbol]:T};type Value=Bag[0];function frames(error:Value){return error.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'union-domain-data-pin',
    source:
      'type Bag={[key:string|symbol]:{stack:string}};type Value=Bag["failure"];function frames(error:Value){return error.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'number-domain-data-pin',
    source:
      'type Bag={[key:number|symbol]:{stack:string}};type Value=Bag[0];function frames(error:Value){return error.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'named-before-union-index-pin',
    source:
      'type Data={stack:string};type Bag={[key:string|symbol]:Error|Data;failure:Data};type Value=Bag["failure"];function frames(error:Value){return error.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'number-before-string-union-pin',
    source:
      'type Data={stack:string};type Bag={[key:string|symbol]:Error|Data;[key:number]:Data};type Value=Bag[0];function frames(error:Value){return error.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'symbol-only-with-data-name-pin',
    source:
      'type Data={stack:string};type Bag={[key:symbol]:Error;failure:Data};type Value=Bag["failure"];function frames(error:Value){return error.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'lexical-domain-shadow-pin',
    source:
      'type Keys=string|symbol;function frames(error:{stack:string}){type Keys=number|symbol;type Bag={[key:Keys]:{stack:string}};type Value=Bag[0];return(error as Value).stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'merged-accessor-read-data',
    source:
      'type Data={stack:string};interface Box{get failure():Data;}interface Box{set failure(value:Error|Data);}type Value=Box["failure"];function frames(error:Value){return error.stack;}',
    refused: false,
    invocation: 'frames({stack:"fixed"})',
  },
];

describe('selected member type readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'selected-member-types.ts', source);
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

describe('shared selected member type admissions', () => {
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
