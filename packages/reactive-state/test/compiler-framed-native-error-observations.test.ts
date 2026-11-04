import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native error observations preserve source-selected result identities and converted words. */
const CASES = [
  {
    id: 'getter-supplied-error',
    source: 'function frames(error:Error){return({get failure(){return error;}}).failure.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    reader: true,
    group: '4326600350',
  },
  {
    id: 'getter-then-setter-keeps-result',
    source:
      'function frames(error:Error){return({get failure(){return error;},set failure(value){void value;}}).failure.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    reader: true,
    group: '4326600350',
  },
  {
    id: 'getter-data-pin',
    source: 'function frames(){return({get failure(){return{stack:"fixed"};}}).failure.stack;}',
    invocation: 'frames()',
    refused: false,
    reader: false,
    group: '4326600350',
  },
  {
    id: 'getter-local-made-words-pin',
    source:
      'function frames(){return({get failure(){return new Error("ours");}}).failure.message;}',
    invocation: 'frames()',
    refused: false,
    reader: false,
    group: '4326600350',
  },
  {
    id: 'reflect-get-call',
    source: 'function frames(error:Error){return Reflect.get.call(null,error,"stack");}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    reader: true,
    group: '4326600406',
  },
  {
    id: 'reflect-get-apply',
    source: 'function frames(error:Error){return Reflect.get.apply(null,[error,"stack"]);}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    reader: true,
    group: '4326600406',
  },
  {
    id: 'reflect-get-reflect-apply',
    source: 'function frames(error:Error){return Reflect.apply(Reflect.get,null,[error,"stack"]);}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    reader: true,
    group: '4326600406',
  },
  {
    id: 'reflect-get-data-pin',
    source: 'function frames(){return Reflect.get.call(null,{stack:"fixed"},"stack");}',
    invocation: 'frames()',
    refused: false,
    reader: false,
    group: '4326600406',
  },
  {
    id: 'reflect-shadow-pin',
    source:
      'const Reflect={get:{call(_receiver:unknown,_target:unknown,_key:string){return"fixed";}}};function frames(error:Error){return Reflect.get.call(null,error,"stack");}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    reader: false,
    group: '4326600406',
  },
  {
    id: 'reflect-construct-error-message',
    source: 'function frames(error:Error){return Reflect.construct(Error,[error]).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    reader: true,
    group: '4326600418',
  },
  {
    id: 'error-call-message',
    source: 'function frames(error:Error){return Error.call(null,error).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    reader: true,
    group: '4326600418',
  },
  {
    id: 'error-apply-message',
    source: 'function frames(error:Error){return Error.apply(null,[error]).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    reader: true,
    group: '4326600418',
  },
  {
    id: 'error-reflect-apply-message',
    source: 'function frames(error:Error){return Reflect.apply(Error,null,[error]).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    reader: true,
    group: '4326600418',
  },
  {
    id: 'indirect-fixed-message-pin',
    source: 'function frames(){return Error.call(null,"fixed").message;}',
    invocation: 'frames()',
    refused: false,
    reader: false,
    group: '4326600418',
  },
  {
    id: 'indirect-local-made-message-pin',
    source: 'function frames(){return Reflect.construct(Error,[new Error("ours")]).message;}',
    invocation: 'frames()',
    refused: true,
    reader: false,
    group: '4326600418',
  },
  {
    id: 'indirect-extra-cause-is-not-message-pin',
    source: 'function frames(error:Error){return Error.call(null,"fixed",{cause:error}).message;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    reader: false,
    group: '4326600418',
  },
  {
    id: 'constructor-cause-error',
    source:
      'function frames(error:Error){return(new Error("fixed",{cause:error}).cause as{stack:string}).stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    reader: true,
    group: '4326600484',
  },
  {
    id: 'aggregate-constructor-cause-error',
    source:
      'function frames(error:Error){return(new AggregateError([],"fixed",{cause:error}).cause as{stack:string}).stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    reader: true,
    group: '4326600484',
  },
  {
    id: 'cause-data-pin',
    source:
      'function frames(){return(new Error("fixed",{cause:{stack:"fixed"}}).cause as{stack:string}).stack;}',
    invocation: 'frames()',
    refused: false,
    reader: false,
    group: '4326600484',
  },
  {
    id: 'cause-local-made-words-pin',
    source:
      'function frames(){return(new Error("fixed",{cause:new Error("ours")}).cause as Error).message;}',
    invocation: 'frames()',
    refused: false,
    reader: false,
    group: '4326600484',
  },
  {
    id: 'weakref-existing-private-pin',
    source: 'function frames(error:Error){return new WeakRef(error).deref()!.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: true,
    reader: false,
    group: '4326600494',
  },
  {
    id: 'weakref-local-shadow-pin',
    source:
      'class WeakRef{constructor(value:unknown){void value;}deref(){return{stack:"fixed"};}}function frames(error:Error){return new WeakRef(error).deref()!.stack;}',
    invocation: 'frames(new Error("supplied"))',
    refused: false,
    reader: false,
    group: '4326600494',
  },
];

describe('native error observation readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-error-observations.ts', source);
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

describe('shared native error observations', () => {
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
