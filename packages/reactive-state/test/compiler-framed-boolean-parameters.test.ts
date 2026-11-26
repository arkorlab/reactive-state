import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Boolean parameters accept their complete literal domains without changing variance or scope. */
interface Case {
  readonly id: string;
  readonly source: string;
  readonly invocation: string;
  readonly refused: boolean;
}

const CASES: readonly Case[] = [
  {
    id: 'reported-literal-union-accepts-boolean',
    source:
      'type Fits=((value:true|false)=>void)extends((value:boolean)=>void)?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'boolean-accepts-both-literals',
    source:
      'type Fits=((value:boolean)=>void)extends((value:true|false)=>void)?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'whole-boolean-alias-domain',
    source:
      'type Both=true|false;type Whole=boolean;type Fits=((value:Both)=>void)extends((value:Whole)=>void)?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-actual-domain',
    source:
      'type Accept<T>=(value:T)=>void;type Fits=Accept<true|false> extends Accept<boolean>?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'optional-boolean-domain',
    source:
      'type Fits=((value?:true|false)=>void)extends((value?:boolean)=>void)?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'rest-array-domain',
    source:
      'type Fits=((...values:(true|false)[])=>void)extends((...values:boolean[])=>void)?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'rest-tuple-domain',
    source:
      'type Fits=((...values:[true|false])=>void)extends((...values:[boolean])=>void)?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'constructor-parameter-domain',
    source:
      'type Fits=(new(value:true|false)=>Date)extends(new(value:boolean)=>Date)?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'method-parameter-domain',
    source:
      'type Fits={run(value:true|false):void}extends{run(value:boolean):void}?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'call-signature-parameter-domain',
    source:
      'type Fits={(value:true|false):void}extends{(value:boolean):void}?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'mixed-string-and-boolean-domain',
    source:
      'type Fits=((value:string|true|false)=>void)extends((value:string|boolean)=>void)?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'true-only-does-not-accept-boolean',
    source:
      'type Fits=((value:true)=>void)extends((value:boolean)=>void)?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'false-only-does-not-accept-boolean',
    source:
      'type Fits=((value:false)=>void)extends((value:boolean)=>void)?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'boolean-accepts-true',
    source:
      'type Fits=((value:boolean)=>void)extends((value:true)=>void)?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'boolean-accepts-false',
    source:
      'type Fits=((value:boolean)=>void)extends((value:false)=>void)?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'both-literals-do-not-accept-unknown',
    source:
      'type Fits=((value:true|false)=>void)extends((value:unknown)=>void)?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'any-accepts-boolean',
    source:
      'type Fits=((value:any)=>void)extends((value:boolean)=>void)?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'never-does-not-accept-boolean',
    source:
      'type Fits=((value:never)=>void)extends((value:boolean)=>void)?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'boolean-existing-any-parameter-rule',
    source:
      'type Fits=((value:boolean)=>void)extends((value:any)=>void)?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unknown-accepts-boolean',
    source:
      'type Fits=((value:unknown)=>void)extends((value:boolean)=>void)?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'boolean-does-not-accept-unknown',
    source:
      'type Fits=((value:boolean)=>void)extends((value:unknown)=>void)?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'covariant-result-keeps-native-error',
    source:
      'type Fits=((value:true|false)=>Error)extends((value:boolean)=>{stack?:string})?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'local-capitalized-boolean-keeps-number',
    source:
      'type Boolean=number;type Fits=((value:true|false)=>void)extends((value:Boolean)=>void)?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'boolean-does-not-accept-extra-string',
    source:
      'type Fits=((value:true|false)=>void)extends((value:boolean|string)=>void)?true:false;type Failure=Fits extends true?Error:{stack:string};function frames(value:Failure){return value.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
];

describe('boolean parameter domain readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'boolean-parameter-domains.ts', source);
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

describe('shared boolean parameter domain admissions', () => {
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
