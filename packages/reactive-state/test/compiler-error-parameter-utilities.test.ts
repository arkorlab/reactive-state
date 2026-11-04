import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native parameter utilities select written call and construct argument sequences. */
const CASES = [
  {
    id: 'parameters-error',
    source: ' function read(value:Parameters<(error:Error)=>void>[0]){return value.stack;}',
    refused: true,
    invocation: 'read(new Error("ours"))',
  },
  {
    id: 'parameters-data',
    source:
      ' function read(value:Parameters<(value:{stack:string})=>void>[0]){return value.stack;}',
    refused: false,
    invocation: 'read({stack:"fixed"})',
  },
  {
    id: 'constructor-parameters-error',
    source:
      ' function read(value:ConstructorParameters<new(error:Error)=>object>[0]){return value.stack;}',
    refused: true,
    invocation: 'read(new Error("ours"))',
  },
  {
    id: 'constructor-parameters-data',
    source:
      ' function read(value:ConstructorParameters<new(value:{stack:string})=>object>[0]){return value.stack;}',
    refused: false,
    invocation: 'read({stack:"fixed"})',
  },
  {
    id: 'generic-parameters-error',
    source:
      'type Fn<T>=(value:T)=>void; function read(value:Parameters<Fn<Error>>[0]){return value.stack;}',
    refused: true,
    invocation: 'read(new Error("ours"))',
  },
  {
    id: 'generic-parameters-data',
    source:
      'type Fn<T>=(value:T)=>void; function read(value:Parameters<Fn<{stack:string}>>[0]){return value.stack;}',
    refused: false,
    invocation: 'read({stack:"fixed"})',
  },
  {
    id: 'array-rest-error',
    source: ' function read(value:Parameters<(...values:Error[])=>void>[0]){return value.stack;}',
    refused: true,
    invocation: 'read(new Error("ours"))',
  },
  {
    id: 'array-rest-data',
    source:
      ' function read(value:Parameters<(...values:{stack:string}[])=>void>[0]){return value.stack;}',
    refused: false,
    invocation: 'read({stack:"fixed"})',
  },
  {
    id: 'optional-error',
    source: ' function read(value:Parameters<(value?:Error)=>void>[0]){return value.stack;}',
    refused: true,
    invocation: 'read(new Error("ours"))',
  },
  {
    id: 'optional-data',
    source:
      ' function read(value:Parameters<(value?:{stack:string})=>void>[0]){return value.stack;}',
    refused: false,
    invocation: 'read({stack:"fixed"})',
  },
  {
    id: 'local-parameters-shadow',
    source:
      'type Parameters<T>=[{stack:string}]; function read(value:Parameters<(error:Error)=>void>[0]){return value.stack;}',
    refused: false,
    invocation: 'read({stack:"fixed"})',
  },
  {
    id: 'local-constructor-parameters-shadow',
    source:
      'type ConstructorParameters<T>=[{stack:string}]; function read(value:ConstructorParameters<new(error:Error)=>object>[0]){return value.stack;}',
    refused: false,
    invocation: 'read({stack:"fixed"})',
  },
  {
    id: 'call-selects-call-parameters',
    source:
      'type Hybrid = {(value:{stack:string}):Error;new(value:Error):{stack:string}}; function read(value:Parameters<Hybrid>[0]){return value.stack;}',
    refused: false,
    invocation: 'read({stack:"fixed"})',
  },
  {
    id: 'construct-selects-construct-parameters',
    source:
      'type Hybrid = {(value:{stack:string}):Error;new(value:Error):{stack:string}}; function read(value:ConstructorParameters<Hybrid>[0]){return value.stack;}',
    refused: true,
    invocation: 'read(new Error("ours"))',
  },
  {
    id: 'call-overload-last-data',
    source:
      ' function read(value:Parameters<{(value:Error):void;(value:{stack:string}):void}>[0]){return value.stack;}',
    refused: false,
    invocation: 'read({stack:"fixed"})',
  },
  {
    id: 'call-overload-last-error',
    source:
      ' function read(value:Parameters<{(value:{stack:string}):void;(value:Error):void}>[0]){return value.stack;}',
    refused: true,
    invocation: 'read(new Error("ours"))',
  },
  {
    id: 'construct-overload-last-data',
    source:
      ' function read(value:ConstructorParameters<{new(value:Error):object;new(value:{stack:string}):object}>[0]){return value.stack;}',
    refused: false,
    invocation: 'read({stack:"fixed"})',
  },
  {
    id: 'construct-overload-last-error',
    source:
      ' function read(value:ConstructorParameters<{new(value:{stack:string}):object;new(value:Error):object}>[0]){return value.stack;}',
    refused: true,
    invocation: 'read(new Error("ours"))',
  },
];

describe('native parameter utility readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'parameter-utility.ts', source);
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

describe('shared native parameter utility results', () => {
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
