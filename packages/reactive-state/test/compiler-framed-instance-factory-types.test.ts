import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native instance utilities and erased factory prefixes retain source-written errors. */
const CASES = [
  {
    group: 'instance',
    id: 'instance-native-error',
    source:
      'type Failure=InstanceType<typeof Error>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    group: 'instance',
    id: 'instance-native-global-typeerror',
    source:
      'type Failure=InstanceType<typeof globalThis.TypeError>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new TypeError("ours"))',
    refused: true,
  },
  {
    group: 'instance',
    id: 'instance-query-alias',
    source:
      'type Constructor=typeof Error;type Failure=InstanceType<Constructor>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    group: 'instance',
    id: 'instance-written-generic-error',
    source:
      'type Maker<T>=new()=>T;type Failure=InstanceType<Maker<Error>>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    group: 'instance',
    id: 'instance-written-data',
    source:
      'type Failure=InstanceType<new()=>{stack:string}>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    group: 'instance',
    id: 'instance-local-utility-data',
    source:
      'type InstanceType<T>={stack:string};type Failure=InstanceType<typeof Error>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
  {
    group: 'instance',
    id: 'instance-shadowed-error-constructor-data',
    source:
      'class Error{stack="fixed"}type Failure=InstanceType<typeof Error>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error())',
    refused: false,
  },
  {
    group: 'instance',
    id: 'instance-shadowed-global-this-data',
    source:
      'const globalThis={Error:class {stack="fixed"}};type Failure=InstanceType<typeof globalThis.Error>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new globalThis.Error())',
    refused: false,
  },
  {
    group: 'factory',
    id: 'factory-type-alias-error',
    source:
      'function make(){type Marker=unknown;return new Error("ours");}function read(){return make().stack;}',
    invocation: 'read()',
    refused: true,
  },
  {
    group: 'factory',
    id: 'factory-interface-error',
    source:
      'function make(){interface Marker{value:string}return new Error("ours");}function read(){return make().stack;}',
    invocation: 'read()',
    refused: true,
  },
  {
    group: 'factory',
    id: 'factory-declare-variable-error',
    source:
      'function make(){declare const marker:unknown;return new Error("ours");}function read(){return make().stack;}',
    invocation: 'read()',
    refused: true,
  },
  {
    group: 'factory',
    id: 'factory-const-type-alias-error',
    source:
      'function make(){const message="ours";type Marker=unknown;return new Error(message);}function read(){return make().stack;}',
    invocation: 'read()',
    refused: true,
  },
  {
    group: 'factory',
    id: 'factory-type-alias-data',
    source:
      'function make(){type Marker=unknown;return {stack:"fixed"};}function read(){return make().stack;}',
    invocation: 'read()',
    refused: false,
  },
  {
    group: 'factory',
    id: 'factory-type-alias-own-words',
    source:
      'function make(){type Marker=unknown;return new Error("ours");}function read(){return make().message;}',
    invocation: 'read()',
    refused: false,
  },
  {
    group: 'factory',
    id: 'factory-runtime-prefix-data',
    source:
      'function make(){let marker="fixed";return {stack:marker};}function read(){return make().stack;}',
    invocation: 'read()',
    refused: false,
  },
  {
    group: 'instance',
    id: 'instance-overload-last-error',
    source:
      'type Failure=InstanceType<{new():{stack:string};new():Error}>;function read(error:Failure){return error.stack;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    group: 'instance',
    id: 'instance-overload-last-data',
    source:
      'type Failure=InstanceType<{new():Error;new():{stack:string}}>;function read(error:Failure){return error.stack;}',
    invocation: 'read({stack:"fixed"})',
    refused: false,
  },
];

describe('instance and factory readers', () => {
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

describe('shared instance and factory results', () => {
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
