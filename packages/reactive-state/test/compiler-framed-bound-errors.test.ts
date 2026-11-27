import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Bound native Error callables retain their creation site and consumed message words. */
const CASES = [
  {
    id: 'bound-direct-call-stack',
    source: 'function frames(){return Error.bind(null,"fixed")().stack;}',
    invocation: 'frames()',
    refused: true,
    reader: true,
  },
  {
    id: 'bound-direct-new-stack',
    source: 'function frames(){return new (Error.bind(null,"fixed") as ErrorConstructor)().stack;}',
    invocation: 'frames()',
    refused: true,
    reader: true,
  },
  {
    id: 'bound-alias-call-stack',
    source: 'function frames(){const Bound=Error.bind(null,"fixed");return Bound().stack;}',
    invocation: 'frames()',
    refused: true,
    reader: true,
  },
  {
    id: 'bound-alias-new-stack',
    source:
      'function frames(){const Bound=Error.bind(null,"fixed") as ErrorConstructor;return new Bound().stack;}',
    invocation: 'frames()',
    refused: true,
    reader: true,
  },
  {
    id: 'bound-constructor-alias-stack',
    source: 'function frames(){const Native=TypeError;return Native.bind(null,"fixed")().stack;}',
    invocation: 'frames()',
    refused: true,
    reader: true,
  },
  {
    id: 'bound-bracket-bind-stack',
    source: 'function frames(){return Error["bind"](null,"fixed")().stack;}',
    invocation: 'frames()',
    refused: true,
    reader: true,
  },
  {
    id: 'bound-return-alias-stack',
    source:
      'function frames(){const Bound=Error.bind(null,"fixed");const alias=Bound;return alias().stack;}',
    invocation: 'frames()',
    refused: true,
    reader: true,
  },
  {
    id: 'bound-global-constructor-stack',
    source: 'function frames(){return globalThis.RangeError.bind(null,"fixed")().stack;}',
    invocation: 'frames()',
    refused: true,
    reader: true,
  },
  {
    id: 'bound-supplied-message',
    source: 'function frames(error:Error){return Error.bind(null,error as never)().message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'bound-runtime-message',
    source: 'function frames(error:Error){return Error.bind(null)(error as never).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'bound-aggregate-message',
    source:
      'function frames(error:Error){return AggregateError.bind(null,[],error as never)().message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'bound-dom-name',
    source:
      'function frames(error:Error){const Bound=DOMException.bind(null,"fixed",error as never);return new Bound().name;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'bound-finite-bound-spread',
    source:
      'function frames(){const args=[null,"fixed"] as const;return Error.bind(...args)().stack;}',
    invocation: 'frames()',
    refused: true,
    reader: true,
  },
  {
    id: 'bound-runtime-fixed-spread',
    source:
      'function frames(){const args=["fixed"] as const;return Error.bind(null)(...args).stack;}',
    invocation: 'frames()',
    refused: true,
    reader: true,
  },
  {
    id: 'bound-local-message-data',
    source: 'function frames(){return Error.bind(null,"fixed")().message;}',
    invocation: 'frames()',
    refused: false,
    reader: false,
  },
  {
    id: 'bound-local-message-alias-data',
    source: 'function frames(){const Bound=Error.bind(null,"fixed");return Bound().message;}',
    invocation: 'frames()',
    refused: false,
    reader: false,
  },
  {
    id: 'bound-local-error-message-data',
    source: 'function frames(){return Error.bind(null,new Error("fixed") as never)().message;}',
    invocation: 'frames()',
    refused: false,
    reader: false,
  },
  {
    id: 'bound-local-error-shadow-data',
    source:
      'function frames(){function Error(_message?:string){return {stack:"fixed",message:"fixed"};}return Error.bind(null,"fixed")().stack;}',
    invocation: 'frames()',
    refused: false,
    reader: false,
  },
  {
    id: 'bound-own-bind-shadow-data',
    source:
      'function frames(){const Error={bind(_this:unknown,_message?:string){return()=>({stack:"fixed"});}};return Error.bind(null,"fixed")().stack;}',
    invocation: 'frames()',
    refused: false,
    reader: false,
  },
  {
    id: 'bound-native-own-bind-replacement-data',
    source:
      'function frames(){const original=Error.bind;try{Error.bind=(()=>()=>({stack:"fixed"})) as typeof Error.bind;return Error.bind(null,"fixed")().stack;}finally{Error.bind=original;}}',
    invocation: 'frames()',
    refused: true,
    reader: true,
  },
  {
    id: 'bound-native-alias-own-bind-data',
    source:
      'function frames(){const Native=Error;const original=Native.bind;try{Native.bind=(()=>()=>({stack:"fixed"})) as typeof Native.bind;return Native.bind(null,"fixed")().stack;}finally{Native.bind=original;}}',
    invocation: 'frames()',
    refused: true,
    reader: true,
  },
  {
    id: 'bound-ignore-later-arguments-data',
    source:
      'function frames(error:Error){return (Error.bind(null,"fixed") as (...args:unknown[])=>Error)(error).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'bound-loop-condition-use',
    source:
      'function frames(){const Bound=Error.bind(null,"fixed");let result:unknown;let i=0;do{result=Bound().stack;}while((void Bound,i++<1));return result;}',
    invocation: 'frames()',
    refused: true,
    reader: true,
  },
  {
    id: 'bound-loop-condition-data',
    source:
      'function frames(){const Bound=Error.bind(null,"fixed");let result:unknown;let i=0;do{result=Bound().message;}while((void Bound,i++<1));return result;}',
    invocation: 'frames()',
    refused: false,
    reader: false,
  },
];

describe('bound native Error readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'reflected-blob.ts', source);
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

describe('bound native Error admissions', () => {
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
