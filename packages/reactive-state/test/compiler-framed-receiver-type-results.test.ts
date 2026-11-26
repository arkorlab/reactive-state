import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native conditional utilities and common written union keys retain selected error results. */
const CASES = [
  {
    group: 'this',
    id: 'this-direct',
    source:
      'type Failure=ThisParameterType<(this:Error)=>void>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'this',
    id: 'this-generic',
    source:
      'type Receiver<T>=ThisParameterType<(this:T)=>void>;function frames(error:Receiver<Error>){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'this',
    id: 'this-interface',
    source:
      'interface Callable{(this:Error):void;}type Failure=ThisParameterType<Callable>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'this',
    id: 'this-overload-last',
    source:
      'interface Callable{(this:{stack:string}):void;(this:Error):void;}type Failure=ThisParameterType<Callable>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'this',
    id: 'this-data',
    source:
      'type Failure=ThisParameterType<(this:{stack:string})=>void>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    group: 'this',
    id: 'this-shadow',
    source:
      'type ThisParameterType<T>={stack:string};type Failure=ThisParameterType<(this:Error)=>void>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    group: 'this',
    id: 'this-overload-data-last',
    source:
      'interface Callable{(this:Error):void;(this:{stack:string}):void;}type Failure=ThisParameterType<Callable>;function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    group: 'this',
    id: 'this-parameters-arity',
    source:
      'type Failure=Parameters<(this:Error,value:{stack:string})=>void>[0];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    group: 'infer',
    id: 'infer-this-direct',
    source:
      'type Receiver<T>=T extends(this:infer U)=>void?U:{stack:string};function frames(error:Receiver<(this:Error)=>void>){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'infer',
    id: 'infer-this-argument',
    source:
      'type Receiver<T>=T extends(this:infer U,value:string)=>void?U:{stack:string};function frames(error:Receiver<(this:Error,value:string)=>void>){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'infer',
    id: 'infer-this-generic',
    source:
      'type Receiver<T>=T extends(this:infer U)=>void?U:{stack:string};type Box<T>=Receiver<(this:T)=>void>;function frames(error:Box<Error>){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'infer',
    id: 'infer-this-data',
    source:
      'type Receiver<T>=T extends(this:infer U)=>void?U:never;function frames(error:Receiver<(this:{stack:string})=>void>){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    group: 'infer',
    id: 'infer-runtime-arity',
    source:
      'type First<T>=T extends(this:Error,...args:infer A)=>void?A[0]:never;function frames(error:First<(this:Error,value:{stack:string})=>void>){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    group: 'interface',
    id: 'interface-direct',
    source:
      'interface Box{failure:Error;}type Failure=Box["failure"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'interface',
    id: 'interface-generic',
    source:
      'interface Box<T>{failure:T;}type Failure=Box<Error>["failure"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'interface',
    id: 'interface-heritage',
    source:
      'interface Base<T>{failure:T;}interface Box<T>extends Base<T>{}type Failure=Box<Error>["failure"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'interface',
    id: 'interface-merged',
    source:
      'interface Box{data:string;}interface Box{failure:Error;}type Failure=Box["failure"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'interface',
    id: 'interface-data',
    source:
      'interface Box{failure:{stack:string};}type Failure=Box["failure"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    group: 'interface',
    id: 'interface-heritage-data',
    source:
      'interface Base<T>{failure:T;}interface Box<T>extends Base<T>{}type Failure=Box<{stack:string}>["failure"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    group: 'interface',
    id: 'interface-selected-data',
    source:
      'interface Box{failure:Error;data:{stack:string};}type Failure=Box["data"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    group: 'record',
    id: 'record-direct',
    source:
      'type Failure=Record<"failure",Error>["failure"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'record',
    id: 'record-generic',
    source:
      'type Box<T>=Record<"failure",T>;type Failure=Box<Error>["failure"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'record',
    id: 'record-string-key',
    source:
      'type Failure=Record<string,Error>["failure"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'record',
    id: 'record-number-key',
    source:
      'type Failure=Record<number,Error>[0];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'record',
    id: 'record-data',
    source:
      'type Failure=Record<"failure",{stack:string}>["failure"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    group: 'record',
    id: 'record-shadow',
    source:
      'type Record<K,V>={failure:{stack:string}};type Failure=Record<"failure",Error>["failure"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    group: 'record',
    id: 'record-selected-data',
    source:
      'type Failure=Record<"failure",Error>&Record<"data",{stack:string}>;function frames(error:Failure["data"]){return error.stack;}',
    invocation: 'frames({stack:"fixed"})',
    refused: false,
  },
  {
    group: 'interface',
    id: 'interface-finite-recursive-path',
    source:
      'interface Box<T>{next:Box<T>;failure:T;}type Failure=Box<Error>["next"]["failure"];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'record',
    id: 'record-negative-numeric-key',
    source:
      'type Failure=Record<number,Error>[-1];function frames(error:Failure){return error.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

describe('receiver-type-results readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-noinfer.ts', source);
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

describe('shared receiver-type-results results', () => {
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
