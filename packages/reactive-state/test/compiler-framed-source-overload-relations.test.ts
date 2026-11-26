import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Non-inference signature relations retain each compatible source-written overload. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
  readonly reader?: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'call-earlier-error-review',
    source:
      'type Data={stack:string};type Source={(value:Error):void;(value:string):void};type Failure=Source extends{(value:Error):void}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'call-last-error-pin',
    source:
      'type Data={stack:string};type Source={(value:string):void;(value:Error):void};type Failure=Source extends{(value:Error):void}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'call-no-matching-parameter-data',
    source:
      'type Data={stack:string};type Source={(value:number):void;(value:string):void};type Failure=Source extends{(value:Error):void}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'call-earlier-literal-result-error',
    source:
      'type Data={stack:string};type Source={(value:Error):{tag:"yes"};(value:string):{tag:"no"}};type Failure=Source extends{(value:Error):{tag:"yes"}}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'call-earlier-incompatible-result-data',
    source:
      'type Data={stack:string};type Source={(value:Error):{tag:"no"};(value:string):{tag:"yes"}};type Failure=Source extends{(value:Error):{tag:"yes"}}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'call-earlier-native-result-error',
    source:
      'type Data={stack:string};type Source={(value:Error):Error;(value:string):Data};type Failure=Source extends{(value:Error):Error}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'call-arity-earlier-error',
    source:
      'type Data={stack:string};type Source={(value:Error):void;(value:string,other:string):void};type Failure=Source extends{(value:Error):void}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'call-ignored-parameter-earlier-error',
    source:
      'type Data={stack:string};type Source={():void;(value:string,other:string):void};type Failure=Source extends{(value:Error):void}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'call-required-arity-data',
    source:
      'type Data={stack:string};type Source={(value:Error,other:Error):void;(value:string,other:string):void};type Failure=Source extends{(value:Error):void}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'call-all-target-signatures-error',
    source:
      'type Data={stack:string};type Source={(value:Error):void;(value:string):void};type Failure=Source extends{(value:Error):void;(value:string):void}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'call-missing-target-signature-data',
    source:
      'type Data={stack:string};type Source={(value:Error):void;(value:string):void};type Failure=Source extends{(value:Error):void;(value:number):void}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'call-generic-alias-original-scope-error',
    source:
      'type Data={stack:string};type Source<T>={(value:T):void;(value:string):void};type Target<T>={(value:T):void};type Failure=Source<Error> extends Target<Error>?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'construct-earlier-error',
    source:
      'type Data={stack:string};type Source={new(value:Error):unknown;new(value:string):unknown};type Failure=Source extends{new(value:Error):unknown}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'construct-last-error-pin',
    source:
      'type Data={stack:string};type Source={new(value:string):unknown;new(value:Error):unknown};type Failure=Source extends{new(value:Error):unknown}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'construct-no-match-data',
    source:
      'type Data={stack:string};type Source={new(value:string):unknown;new(value:number):unknown};type Failure=Source extends{new(value:Error):unknown}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'construct-earlier-literal-result-error',
    source:
      'type Data={stack:string};type Source={new(value:Error):{tag:"yes"};new(value:string):{tag:"no"}};type Failure=Source extends{new(value:Error):{tag:"yes"}}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'construct-incompatible-result-data',
    source:
      'type Data={stack:string};type Source={new(value:Error):{tag:"no"};new(value:string):{tag:"yes"}};type Failure=Source extends{new(value:Error):{tag:"yes"}}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'call-construct-source-distinct-data',
    source:
      'type Data={stack:string};type Source={new(value:Error):unknown;new(value:string):unknown};type Failure=Source extends{(value:Error):unknown}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'construct-call-source-distinct-data',
    source:
      'type Data={stack:string};type Source={(value:Error):unknown;(value:string):unknown};type Failure=Source extends{new(value:Error):unknown}?Error:Data;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'call-inference-last-error-pin',
    source:
      'type Data={stack:string};type Source={(value:Data):Data;(value:Error):Error};type Extract<T>=T extends{(value:infer A):infer R}?R:never;type Failure=Extract<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'call-inference-last-data-pin',
    source:
      'type Data={stack:string};type Source={(value:Error):Error;(value:Data):Data};type Extract<T>=T extends{(value:infer A):infer R}?R:never;type Failure=Extract<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'construct-inference-last-error-pin',
    source:
      'type Data={stack:string};type Source={new(value:Data):Data;new(value:Error):Error};type Extract<T>=T extends{new(value:infer A):infer R}?R:never;type Failure=Extract<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'construct-inference-last-data-pin',
    source:
      'type Data={stack:string};type Source={new(value:Error):Error;new(value:Data):Data};type Extract<T>=T extends{new(value:infer A):infer R}?R:never;type Failure=Extract<Source>;function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
];

describe('source overload relation readers', () => {
  it.each(CASES)('$id', ({ source, refused, reader = refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'source-overload-relations.ts', source);
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

describe('shared source overload relation admissions', () => {
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
