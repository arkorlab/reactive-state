import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Required pattern positions retain any without changing optional source acceptance. */
const CASES = [
  {
    id: 'fixed-any-error-result',
    refused: true,
    source:
      'type Result<T> = T extends (a:any)=>infer R?R:{stack:string}; type Failure = Result<(x:string)=>Error>; function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'fixed-any-data-result',
    refused: false,
    source:
      'type Result<T> = T extends (a:any)=>infer R?R:Error; type Failure = Result<(x:string)=>{stack:string}>; function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'default-generic-any-pattern',
    refused: true,
    source:
      'type Result<T,P=any> = T extends (a:P)=>infer R?R:{stack:string}; type Failure = Result<(x:string)=>Error>; function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'fixed-any-constructor-result',
    refused: true,
    source:
      'type Result<T> = T extends new(a:any)=>infer R?R:{stack:string}; type Failure = Result<new(x:string)=>Error>; function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'source-any-accepts-optional',
    refused: true,
    source:
      'type Result<T> = T extends (a?:string)=>infer R?R:{stack:string}; type Failure = Result<(x:any)=>Error>; function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'source-undefined-accepts-optional',
    refused: true,
    source:
      'type Result<T> = T extends (a?:string)=>infer R?R:{stack:string}; type Failure = Result<(x:string|undefined)=>Error>; function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'required-source-rejects-optional',
    refused: false,
    source:
      'type Result<T> = T extends (a?:string)=>infer R?R:{stack:string}; type Failure = Result<(x:string)=>Error>; function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'optional-source-accepts-undefined',
    refused: true,
    source:
      'type Result<T> = T extends (a:string|undefined)=>infer R?R:{stack:string}; type Failure = Result<(x?:string)=>Error>; function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-array-rest-pattern',
    refused: true,
    source:
      'type Result<T> = T extends (...a:any[])=>infer R?R:{stack:string}; type Failure = Result<(x:string)=>Error>; function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'required-source-rejects-empty',
    refused: false,
    source:
      'type Result<T> = T extends ()=>infer R?R:{stack:string}; type Failure = Result<(x:string)=>Error>; function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'unknown-pattern-remains-incompatible',
    refused: false,
    source:
      'type Result<T> = T extends (a:unknown)=>infer R?R:{stack:string}; type Failure = Result<(x:string)=>Error>; function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
  },
  {
    id: 'same-required-string-pattern',
    refused: true,
    source:
      'type Result<T> = T extends (a:string)=>infer R?R:{stack:string}; type Failure = Result<(x:string)=>Error>; function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
  },
];

describe('fixed any function pattern readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'fixed-any-function.ts', source);
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

describe('shared fixed any function patterns', () => {
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
    const sharedReason = expect.stringContaining('a shared module that answers otherwise');
    const expected = refused ? [sharedReason] : [];

    expect(reasons).toStrictEqual(expected);
  });
});
