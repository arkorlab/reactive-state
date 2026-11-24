import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native cloning discards only source-proven ordinary inherited Error members. */
const CASES = [
  {
    id: 'reported-inherited-stack',
    source:
      'function frames(error:Error){return structuredClone(Object.create(error)).stack ?? "fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'inherited-message-is-not-cloned',
    source:
      'function frames(error:Error){return structuredClone(Object.create(error)).message ?? "fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'created-whole-constant-alias',
    source:
      'function frames(error:Error){const original=Object.create(error);return structuredClone(original).stack ?? "fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'explicit-undefined-descriptors',
    source:
      'function frames(error:Error){return structuredClone(Object.create(error,undefined as never)).stack ?? "fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'empty-own-descriptors',
    source:
      'function frames(error:Error){return structuredClone(Object.create(error,{})).stack ?? "fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nonenumerable-own-stack-is-not-cloned',
    source:
      'function frames(error:Error){return structuredClone(Object.create(error,{stack:{value:"hidden"}})).stack ?? "fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'nonenumerable-own-Error-is-not-cloned',
    source:
      'function frames(error:Error){return structuredClone(Object.create(error,{hidden:{value:error}})).stack ?? "fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'enumerable-own-fixed-stack',
    source:
      'function frames(error:Error){return structuredClone(Object.create(error,{stack:{value:"fixed",enumerable:true}})).stack ?? "fallback";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'empty-transfer-list',
    source:
      'function frames(error:Error){return structuredClone(Object.create(error),{transfer:[]}).stack ?? "fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'supplied-Error-clone-retains-frames',
    source: 'function frames(error:Error){return structuredClone(error).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'supplied-Error-clone-retains-words',
    source: 'function frames(error:Error){return structuredClone(error).message;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'constructed-Error-clone-retains-frames',
    source: 'function frames(_error:Error){return structuredClone(new Error("ours")).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'constructed-Error-clone-keeps-own-words',
    source: 'function frames(_error:Error){return structuredClone(new Error("ours")).message;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'enumerable-own-frame-value-is-cloned',
    source:
      'function frames(error:Error){return structuredClone(Object.create(error,{stack:{value:error.stack,enumerable:true}})).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'enumerable-own-getter-keeps-boundary',
    source:
      'function frames(error:Error){return structuredClone(Object.create(error,{stack:{get(){return "fixed";},enumerable:true}})).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unknown-options-keep-boundary',
    source:
      'function frames(error:Error,options:StructuredSerializeOptions){return structuredClone(Object.create(error),options).stack ?? "fixed";}',
    refused: true,
    invocation: 'frames(new Error("ours"),{})',
  },
  {
    id: 'buffer-transfer-keeps-boundary',
    source:
      'function frames(error:Error,buffer:ArrayBuffer){return structuredClone(Object.create(error),{transfer:[buffer]}).stack ?? "fixed";}',
    refused: true,
    invocation: 'frames(new Error("ours"),new ArrayBuffer(8))',
  },
  {
    id: 'exposed-created-alias-keeps-boundary',
    source:
      'function frames(error:Error){const original=Object.create(error);function observe(_value:unknown){}observe(original);return structuredClone(original).stack ?? "fixed";}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'known-empty-clone-behind-Error-assertion',
    source:
      'function frames(error:Error){return (structuredClone(Object.create(error)) as Error).stack ?? "fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'local-clone-keeps-own-Error-result',
    source:
      'function frames(error:Error){const structuredClone=(_value:unknown)=>error;return structuredClone(Object.create(error)).stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'ordinary-own-data-clone',
    source: 'function frames(_error:Error){return structuredClone({stack:"fixed"}).stack;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unknown-clone-primary-keeps-assertion',
    source:
      'function frames(value:unknown){return (structuredClone(value) as Error).stack ?? "fixed";}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'saved-cloned-result-unchanged',
    source:
      'function frames(error:Error){const cloned=structuredClone(Object.create(error));return cloned.stack ?? "fixed";}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'saved-cloned-result-prototype-replaced',
    source:
      'function frames(error:Error){const cloned=structuredClone(Object.create(error));Object.setPrototypeOf(cloned,error);return cloned.message;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'enumerable-own-Error-field-retained',
    source:
      'function frames(error:Error){return structuredClone(Object.create(error,{failure:{value:error,enumerable:true}})).failure.stack;}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'opaque-descriptor-keeps-boundary',
    source:
      'function frames(error:Error,descriptor:PropertyDescriptor){return structuredClone(Object.create(error,{0:descriptor,stack:{value:"fixed",enumerable:true,writable:true}})).stack;}',
    refused: true,
    invocation:
      'frames(new Error("ours"),{enumerable:true,get(this:{stack:string}){const base=Object.getPrototypeOf(this);this.stack=Reflect.get(base,"stack",base);return 0;}})',
  },
] as const;

describe('clone inherited Error readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-encoding-callbacks.ts', source);
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

describe('shared clone inherited Error text', () => {
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
