import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native text encoders and Symbol descriptions convert only their consumed arguments. */
const CASES = [
  {
    id: 'encoder-encode',
    source: 'function frames(error:Error){return new TextEncoder().encode(error as never)[0];}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'encoder-encode-into',
    source:
      'function frames(error:Error){return new TextEncoder().encodeInto(error as never,new Uint8Array(100)).written;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'encoder-instance-alias',
    source:
      'function frames(error:Error){const encoder=new TextEncoder();return encoder.encode(error as never)[0];}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'encoder-constructor-alias',
    source:
      'function frames(error:Error){const Encoder=TextEncoder;return new Encoder().encode(error as never)[0];}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'global-encoder',
    source:
      'function frames(error:Error){return new globalThis.TextEncoder().encode(error as never)[0];}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'encoder-array-conversion',
    source: 'function frames(error:Error){return new TextEncoder().encode([error] as never)[0];}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'encoder-spread-first',
    source:
      'function frames(error:Error){return new TextEncoder().encode(...[error as never] as [never])[0];}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'encoder-borrowed-call',
    source:
      'function frames(error:Error){return TextEncoder.prototype.encode.call(new TextEncoder(),error as never)[0];}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'encoder-borrowed-apply',
    source:
      'function frames(error:Error){return TextEncoder.prototype.encode.apply(new TextEncoder(),[error as never])[0];}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'encoder-reflect-apply',
    source:
      'function frames(error:Error){return Reflect.apply(TextEncoder.prototype.encode,new TextEncoder(),[error])[0];}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'encoder-caught-words',
    source:
      'function frames(){try{JSON.parse("{");}catch(error){return new TextEncoder().encode(error as never)[0];}return 0;}',
    refused: true,
    invocation: 'frames()',
  },
  {
    id: 'symbol-description',
    source: 'function frames(error:Error){return Symbol(error as never).description;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'symbol-global',
    source: 'function frames(error:Error){return globalThis.Symbol(error as never).description;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'symbol-alias',
    source:
      'function frames(error:Error){const Make=Symbol;return Make(error as never).description;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'symbol-array-conversion',
    source: 'function frames(error:Error){return Symbol([error] as never).description;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'symbol-spread',
    source:
      'function frames(error:Error){return Symbol(...[error as never] as [never]).description;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'symbol-call',
    source: 'function frames(error:Error){return Symbol.call(null,error as never).description;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'symbol-apply',
    source: 'function frames(error:Error){return Symbol.apply(null,[error as never]).description;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'symbol-reflect-apply',
    source: 'function frames(error:Error){return Reflect.apply(Symbol,null,[error]).description;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'local-encoder-words',
    source: 'function frames(){return new TextEncoder().encode(new Error("ours") as never)[0];}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'local-symbol-words',
    source: 'function frames(){return Symbol(new Error("ours") as never).description;}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'encoder-literal',
    source: 'function frames(){return new TextEncoder().encode("fixed")[0];}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'symbol-literal',
    source: 'function frames(){return Symbol("fixed").description;}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'encoder-empty',
    source: 'function frames(){return new TextEncoder().encode().length;}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'symbol-empty',
    source: 'function frames(){return Symbol().description;}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'encoder-ignored-later',
    source:
      'function frames(error:Error){return (new TextEncoder().encode as (...args:unknown[])=>Uint8Array)("fixed",error)[0];}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'symbol-ignored-later',
    source:
      'function frames(error:Error){return (Symbol as (...args:unknown[])=>symbol)("fixed",error).description;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'symbol-ignored-receiver',
    source: 'function frames(error:Error){return Symbol.call(error,"fixed").description;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'encoder-own-method',
    source:
      'function frames(error:Error){const encoder={encode:(_value:unknown)=>[1]};return encoder.encode(error)[0];}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'encoder-local-shadow',
    source:
      'class TextEncoder{encode(_value:unknown){return [1]}}function frames(error:Error){return new TextEncoder().encode(error)[0];}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'symbol-local-shadow',
    source:
      'function frames(error:Error){const Symbol=(_value:unknown)=>({description:"fixed"});return Symbol(error).description;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'symbol-projected-shadow',
    source:
      'function frames(error:Error){const {Symbol:Make}={Symbol:(_value:unknown)=>({description:"fixed"})};return Make(error).description;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'encoder-local-error-shadow',
    source:
      'class Error{message="fixed"}function frames(){return new TextEncoder().encode(new Error() as never)[0];}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'symbol-local-error-shadow',
    source:
      'class Error{message="fixed"}function frames(){return Symbol(new Error() as never).description;}',
    refused: false,
    invocation: 'frames()',
  },
];

describe('platform text error readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'recursive-error-members.ts', source);
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

describe('shared platform text errors', () => {
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
