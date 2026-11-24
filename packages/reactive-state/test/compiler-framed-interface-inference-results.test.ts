import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Named interface fields and call results keep their own written types. */
const CASES = [
  {
    id: 'conditional-interface-error',
    source:
      'interface Box{value:Error}type R<T>=T extends{value:infer U}?U:{stack:string};type Failure=R<Box>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'conditional-interface-data',
    source:
      'interface Box{value:{stack:string}}type R<T>=T extends{value:infer U}?U:{stack:string};type Failure=R<Box>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'conditional-generic-error',
    source:
      'interface Box<T>{value:T}type R<T>=T extends{value:infer U}?U:{stack:string};type Failure=R<Box<Error>>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'conditional-default-error',
    source:
      'interface Box<T=Error>{value:T}type R<T>=T extends{value:infer U}?U:{stack:string};type Failure=R<Box>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'conditional-inherited-error',
    source:
      'interface Base<T>{value:T}interface Box extends Base<Error>{}type R<T>=T extends{value:infer U}?U:{stack:string};type Failure=R<Box>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'conditional-optional-field-data',
    source:
      'interface Box{value?:Error}type R<T>=T extends{value:infer U}?U:{stack:string};type Failure=R<Box>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'conditional-merged-fields-error',
    source:
      'interface Box{other:string}interface Box{value:Error}type R<T>=T extends{value:infer U}?U:{stack:string};type Failure=R<Box>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'conditional-lexical-shadow-data',
    source:
      'interface Box{value:Error}type R<T>=T extends{value:infer U}?U:{stack:string};function read(){interface Box{value:{stack:string}}type Failure=R<Box>;const error:Failure={stack:"fixed"};return error.stack;}',
    invocation: 'read()',
    refused: false,
  },
  {
    id: 'returntype-interface-error',
    source:
      'interface Factory{():Error}type Failure=ReturnType<Factory>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'returntype-interface-data',
    source:
      'interface Factory{():{stack:string}}type Failure=ReturnType<Factory>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'returntype-generic-error',
    source:
      'interface Factory<T>{():T}type Failure=ReturnType<Factory<Error>>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'returntype-default-error',
    source:
      'interface Factory<T=Error>{():T}type Failure=ReturnType<Factory>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'returntype-inherited-error',
    source:
      'interface Base<T>{():T}interface Factory extends Base<Error>{}type Failure=ReturnType<Factory>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'returntype-last-overload-error',
    source:
      'interface Factory{(value:string):{stack:string};(value:number):Error}type Failure=ReturnType<Factory>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'returntype-last-overload-data',
    source:
      'interface Factory{(value:string):Error;(value:number):{stack:string}}type Failure=ReturnType<Factory>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'returntype-utility-shadow-data',
    source:
      'type ReturnType<T>={stack:string};interface Factory{():Error}type Failure=ReturnType<Factory>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'returntype-merged-last-error',
    source:
      'interface Factory{():{stack:string}}interface Factory{():Error}type Failure=ReturnType<Factory>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'returntype-merged-last-data',
    source:
      'interface Factory{():Error}interface Factory{():{stack:string}}type Failure=ReturnType<Factory>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'returntype-bases-last-error',
    source:
      'interface A{():{stack:string}}interface B{():Error}interface Factory extends A,B{}type Failure=ReturnType<Factory>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'returntype-bases-last-data',
    source:
      'interface A{():Error}interface B{():{stack:string}}interface Factory extends A,B{}type Failure=ReturnType<Factory>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'returntype-inherited-unknown-data',
    source:
      'interface Parent{():unknown}interface Factory extends Parent{():Error}type Failure=ReturnType<Factory> extends Error?Error:{stack:string};function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    id: 'conditional-recursive-finite-error',
    source:
      'interface Box<T>{next:Box<T>;value:T}type R<T>=T extends{next:{value:infer U}}?U:{stack:string};type Failure=R<Box<Error>>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    id: 'conditional-recursive-finite-data',
    source:
      'interface Box<T>{next:Box<T>;value:T}type R<T>=T extends{next:{value:infer U}}?U:{stack:string};type Failure=R<Box<{stack:string}>>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
];

describe('named interface inference readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'instance-factory.ts', source);
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

describe('shared named interface inference results', () => {
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

    expect(reasons).toStrictEqual(refused ? [shared] : []);
  });
});
