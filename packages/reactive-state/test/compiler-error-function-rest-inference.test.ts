import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Whole inferred argument sequences retain their native error elements and data controls. */
const CASES = [
  {
    id: 'required-error',
    source:
      'type Argument<F> = F extends (...args: infer P) => unknown ? P[0] : never; function read(value: Argument<(error:Error)=>void>){return value.stack;}',
    refused: true,
    invocation: 'read(new Error("ours"))',
  },
  {
    id: 'required-data',
    source:
      'type Argument<F> = F extends (...args: infer P) => unknown ? P[0] : never; function read(value: Argument<(data:{stack:string})=>void>){return value.stack;}',
    refused: false,
    invocation: 'read({stack:"fixed"})',
  },
  {
    id: 'generic-error',
    source:
      'type Fn<T>=(value:T)=>void; type Argument<F> = F extends (...args: infer P) => unknown ? P[0] : never; function read(value: Argument<Fn<Error>>){return value.stack;}',
    refused: true,
    invocation: 'read(new Error("ours"))',
  },
  {
    id: 'generic-data',
    source:
      'type Fn<T>=(value:T)=>void; type Argument<F> = F extends (...args: infer P) => unknown ? P[0] : never; function read(value: Argument<Fn<{stack:string}>>){return value.stack;}',
    refused: false,
    invocation: 'read({stack:"fixed"})',
  },
  {
    id: 'native-array-error',
    source:
      'type Argument<F> = F extends (...args: infer P) => unknown ? P[0] : never; function read(value: Argument<(...values:Error[])=>void>){return value.stack;}',
    refused: true,
    invocation: 'read(new Error("ours"))',
  },
  {
    id: 'native-array-data',
    source:
      'type Argument<F> = F extends (...args: infer P) => unknown ? P[0] : never; function read(value: Argument<(...values:{stack:string}[])=>void>){return value.stack;}',
    refused: false,
    invocation: 'read({stack:"fixed"})',
  },
  {
    id: 'prefix-tail-error',
    source:
      'type Argument<F> = F extends (prefix:string,...args:infer P)=>unknown ? P[0] : never; function read(value: Argument<(prefix:string,value:Error)=>void>){return value.stack;}',
    refused: true,
    invocation: 'read(new Error("ours"))',
  },
  {
    id: 'prefix-tail-data',
    source:
      'type Argument<F> = F extends (prefix:string,...args:infer P)=>unknown ? P[0] : never; function read(value: Argument<(prefix:string,value:{stack:string})=>void>){return value.stack;}',
    refused: false,
    invocation: 'read({stack:"fixed"})',
  },
  {
    id: 'constructor-error',
    source:
      'type Argument<F> = F extends new (...args:infer P)=>unknown ? P[0] : never; function read(value: Argument<new (value:Error)=>object>){return value.stack;}',
    refused: true,
    invocation: 'read(new Error("ours"))',
  },
  {
    id: 'constructor-data',
    source:
      'type Argument<F> = F extends new (...args:infer P)=>unknown ? P[0] : never; function read(value: Argument<new (value:{stack:string})=>object>){return value.stack;}',
    refused: false,
    invocation: 'read({stack:"fixed"})',
  },
  {
    id: 'optional-error',
    source:
      'type Argument<F> = F extends (...args: infer P) => unknown ? P[0] : never; function read(value: Argument<(error?:Error)=>void>){return value.stack;}',
    refused: true,
    invocation: 'read(new Error("ours"))',
  },
  {
    id: 'optional-position-stays-optional',
    source:
      'type Argument<F> = F extends (...args:infer P)=>unknown ? P extends [infer E] ? E : {stack:string} : never; function read(value: Argument<(error?:Error)=>void>){return value.stack;}',
    refused: false,
    invocation: 'read({stack:"fixed"})',
  },
  {
    id: 'empty-parameter-capture',
    source:
      'type Argument<F> = F extends (...args:infer P)=>unknown ? P extends [] ? Error : {stack:string} : never; function read(value: Argument<()=>void>){return value.stack;}',
    refused: true,
    invocation: 'read(new Error("ours"))',
  },
  {
    id: 'noncallable-data',
    source:
      'type Argument<F> = F extends (...args: infer P) => unknown ? P[0] : {stack:string}; function read(value: Argument<{value:string}>){return value.stack;}',
    refused: false,
    invocation: 'read({stack:"fixed"})',
  },
];

describe('written function rest inference readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'function-rest-inference.ts', source);
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

describe('shared function rest inference results', () => {
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
