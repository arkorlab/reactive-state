import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Bound Error message origins preserve native evaluation order and opaque assertion fallback. */
const CASES = [
  {
    id: 'bound-prior-own-conversion-data-pin',
    source:
      'function frames(error:Error){Object.defineProperty(error,"toString",{value:()=>"fixed"});return Error.bind(null,error as never)().message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'bound-ignored-runtime-tail-conversion-data-pin',
    source:
      'function frames(error:Error){return (Error.bind(null,error as never) as (...args:unknown[])=>Error)(Object.defineProperty(error,"toString",{value:()=>"fixed"})).message;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
    reader: false,
  },
  {
    id: 'bound-native-sensitive-message-control',
    source: 'function frames(error:Error){return Error.bind(null,error as never)().message;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
    reader: true,
  },
  {
    id: 'bound-prior-own-conversion-stack-control',
    source:
      'function frames(error:Error){Object.defineProperty(error,"toString",{value:()=>"fixed"});return Error.bind(null,error as never)().stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'bound-ignored-runtime-tail-stack-control',
    source:
      'function frames(error:Error){return (Error.bind(null,error as never) as (...args:unknown[])=>Error)(Object.defineProperty(error,"toString",{value:()=>"fixed"})).stack;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'bound-opaque-input-assertion-fallback-control',
    source:
      'function frames(error:Error){const held=error;return (Error.bind(null,error as never)() as Error).message;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'bound-fixed-own-input-existing-assertion-pin',
    source:
      'function frames(error:Error){Object.defineProperty(error,"toString",{value:()=>"fixed"});return (Error.bind(null,error as never)() as Error).message;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'bound-ignored-bind-receiver-conversion-pin',
    source:
      'function frames(error:Error){return Error.bind(Object.defineProperty(error,"toString",{value:()=>"fixed"}),error as never)().message;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'bound-dom-prior-message-conversion-pin',
    source:
      'function frames(error:Error){function collect(value:Error,head:unknown){const Bound=DOMException.bind(null,head as never,value as never);return new Bound().name;}return collect(error,{toString(){Object.defineProperty(error,"toString",{value:()=>"fixed"});return "first";}});}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'bound-aggregate-opaque-iterable-original-opacity-pin',
    source:
      'function frames(error:Error){function collect(value:Error,iterable:Iterable<unknown>){return AggregateError.bind(null,iterable,value as never)().message;}return collect(error,{*[Symbol.iterator](){Object.defineProperty(error,"toString",{value:()=>"fixed"});yield 0;}});}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'bound-captured-holder-later-conversion-pin',
    source:
      'function frames(error:Error){const words=[error as never] as const;const Bound=Error.bind(null,...words);Object.defineProperty(words[0],"toString",{value:()=>"fixed"});return Bound().message;}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'bound-prior-callback-conversion-pin',
    source:
      'function frames(error:Error){function collect(value:Error,head:()=>void){const Bound=Error.bind(null,value as never);head();return Bound().message;}return collect(error,()=>{Object.defineProperty(error,"toString",{value:()=>"fixed"});});}',
    reader: false,
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'bound-dom-known-prior-message-control',
    source:
      'function frames(error:Error){const head="fixed";const Bound=DOMException.bind(null,head,error as never);return new Bound().name;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'bound-aggregate-empty-iterable-control',
    source:
      'function frames(error:Error){return AggregateError.bind(null,[],error as never)().message;}',
    reader: true,
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'bound-as-array-original-opacity-pin',
    source:
      'function frames(error:Error){const values=[Error.bind(null,error as never)()] as Error[];return values.join();}',
    invocation: 'frames(new Error("ours"))',
    reader: false,
    refused: false,
  },
  {
    id: 'bound-fixed-array-local-words-control',
    source:
      'function frames(){const values=[Error.bind(null,"fixed")()] as Error[];return values.join();}',
    invocation: 'frames()',
    reader: false,
    refused: false,
  },
  {
    id: 'annotated-array-existing-error',
    source:
      'function frames(error:Error){const values:Error[]=[Error.bind(null,error as never)()];return values.join();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'annotated-callback-existing-error',
    source:
      'function frames(error:Error){const values:Error[]=[Error.bind(null,error as never)()];return values.map(value=>value.message).join();}',
    invocation: 'frames(new Error("ours"))',
    reader: true,
    refused: true,
  },
  {
    id: 'annotated-callback-fixed-data',
    source:
      'function frames(){const values:Error[]=[Error.bind(null,"fixed")()];return values.map(value=>value.message).join();}',
    invocation: 'frames()',
    reader: false,
    refused: false,
  },
];

describe('bound Error message order readers', () => {
  it.each(CASES)('$id', ({ source, reader }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'bound-error-order.ts', source);
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

describe('bound Error message order admissions', () => {
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
