import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native instance utilities and erased factory prefixes retain source-written errors. */
const CASES = [
  {
    group: 'interface',
    id: 'interface-field-error',
    source: 'interface Box<T>{value:T}function read(box:Box<Error>){return box.value.stack;}',
    invocation: 'read({value:new Error("ours")})',
    refused: true,
  },
  {
    group: 'interface',
    id: 'interface-field-data',
    source:
      'interface Box<T>{value:T}function read(box:Box<{stack:string}>){return box.value.stack;}',
    invocation: 'read({value:{stack:"fixed"}})',
    refused: false,
  },
  {
    group: 'interface',
    id: 'interface-field-default-error',
    source: 'interface Box<T=Error>{value:T}function read(box:Box){return box.value.stack;}',
    invocation: 'read({value:new Error("ours")})',
    refused: true,
  },
  {
    group: 'interface',
    id: 'interface-field-alias-error',
    source:
      'interface Box<T>{value:T}type Wrapped<T>=Box<T>;function read(box:Wrapped<Error>){return box.value.stack;}',
    invocation: 'read({value:new Error("ours")})',
    refused: true,
  },
  {
    group: 'interface',
    id: 'interface-field-inherited-error',
    source:
      'interface Base<T>{value:T}interface Box<T> extends Base<T>{}function read(box:Box<Error>){return box.value.stack;}',
    invocation: 'read({value:new Error("ours")})',
    refused: true,
  },
  {
    group: 'interface',
    id: 'interface-field-recursive-error',
    source:
      'interface Box<T>{value:T;next:Box<T>}function read(box:Box<Error>){return box.next.value.stack;}',
    invocation: 'read({value:new Error("ours"),next:{value:new Error("ours")} as Box<Error>})',
    refused: true,
  },
  {
    group: 'interface',
    id: 'interface-field-local-shadow-data',
    source:
      'interface Box<T>{value:T}function read(){interface Box<T>{value:{stack:string}}const box:Box<Error>={value:{stack:"fixed"}};return box.value.stack;}',
    invocation: 'read()',
    refused: false,
  },
  {
    group: 'factory',
    id: 'factory-actual-generic-error',
    source:
      'function pass<T>(value:T){return value}function read(){return pass(new Error("ours")).stack;}',
    invocation: 'read()',
    refused: true,
  },
  {
    group: 'factory',
    id: 'factory-actual-generic-data',
    source:
      'function pass<T>(value:T){return value}function read(){return pass({stack:"fixed"}).stack;}',
    invocation: 'read()',
    refused: false,
  },
  {
    group: 'factory',
    id: 'factory-actual-supplied-words',
    source:
      'function pass<T>(value:T){return value}function read(error:Error){return pass(error).message;}',
    invocation: 'read(new Error("ours"))',
    refused: true,
  },
  {
    group: 'factory',
    id: 'factory-actual-own-words',
    source:
      'function pass<T>(value:T){return value}function read(){return pass(new Error("ours")).message;}',
    invocation: 'read()',
    refused: false,
  },
  {
    group: 'factory',
    id: 'factory-actual-arrow-error',
    source:
      'const pass=<T,>(value:T)=>value;function read(){return pass(new Error("ours")).stack;}',
    invocation: 'read()',
    refused: true,
  },
  {
    group: 'factory',
    id: 'factory-actual-ignored-parameter-data',
    source:
      'function pass<T>(value:T){const result={stack:"fixed"};return result}function read(){return pass(new Error("ours")).stack;}',
    invocation: 'read()',
    refused: false,
  },
  {
    group: 'factory',
    id: 'factory-actual-provided-default-data',
    source:
      'function pass<T>(value:T=new Error("ours") as T){return value}function read(){return pass({stack:"fixed"}).stack;}',
    invocation: 'read()',
    refused: false,
  },
  {
    group: 'factory',
    id: 'factory-actual-type-only-prefix-error',
    source:
      'function pass<T>(value:T){type Marker=unknown;return value}function read(){return pass(new Error("ours")).stack;}',
    invocation: 'read()',
    refused: true,
  },
  {
    group: 'factory',
    id: 'factory-actual-alias-error',
    source:
      'function pass<T>(value:T){const selected=value;return selected}function read(){return pass(new Error("ours")).stack;}',
    invocation: 'read()',
    refused: true,
  },
  {
    group: 'factory',
    id: 'factory-actual-alias-data',
    source:
      'function pass<T>(value:T){const selected=value;return selected}function read(){return pass({stack:"fixed"}).stack;}',
    invocation: 'read()',
    refused: false,
  },
  {
    group: 'factory',
    id: 'factory-actual-omitted-default-error',
    source:
      'function pass<T>(value:T=new Error("ours") as T){return value}function read(){return pass<Error>().stack;}',
    invocation: 'read()',
    refused: true,
  },
  {
    group: 'factory',
    id: 'factory-actual-undefined-default-error',
    source:
      'function pass<T>(value:T=new Error("ours") as T){return value}function read(){return pass<Error>(undefined).stack;}',
    invocation: 'read()',
    refused: true,
  },
];

describe('interface field and actual factory readers', () => {
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

describe('shared interface field and actual factory results', () => {
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
