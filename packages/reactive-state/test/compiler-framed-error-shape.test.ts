import { appendFileSync } from 'node:fs';

import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Error observations retain runtime identity and source-written data boundaries. */
const CASES = [
  {
    id: 'native-property-names',
    source: 'function frames(error:Error){return Object.getOwnPropertyNames(error).join(",");}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'reflect-own-keys',
    source: 'function frames(error:Error){return Reflect.ownKeys(error).join(",");}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-has-own-file-name',
    source: 'function frames(error:Error){return Object.hasOwn(error,"fileName");}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'global-has-own-stack',
    source: 'function frames(error:Error){return globalThis.Object.hasOwn(error,"stack");}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unknown-presence-key',
    source: 'function frames(error:Error,key:string){return Object.hasOwn(error,key);}',
    refused: true,
    invocation: 'frames(new Error("ours"),"fileName")',
  },
  {
    id: 'finite-presence-key',
    source:
      'function frames(error:Error,key:"fileName"|"plain"="plain"){return Object.hasOwn(error,key);}',
    refused: true,
    invocation: 'frames(new Error("ours"),"fileName")',
  },
  {
    id: 'borrowed-prototype-call',
    source:
      'function frames(error:Error){return Object.prototype.hasOwnProperty.call(error,"fileName");}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-prototype-reflect',
    source:
      'function frames(error:Error){return Reflect.apply(Object.prototype.hasOwnProperty,error,["lineNumber"]);}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'borrowed-static-apply',
    source:
      'function frames(error:Error){return Object.hasOwn.apply(null,[error,"columnNumber"]);}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'immutable-names-alias',
    source:
      'function frames(error:Error){const names=Object.getOwnPropertyNames;return names(error).join(",");}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'literal-presence-spread',
    source:
      'function frames(error:Error){return Object.hasOwn(...[error,"stack"] as [Error,string]);}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'made-error-layout',
    source: 'function frames(){return Object.getOwnPropertyNames(new Error("ours")).join(",");}',
    refused: true,
    invocation: 'frames()',
  },
  {
    id: 'ordinary-literal-layout',
    source:
      'function frames(){return Object.getOwnPropertyNames({fileName:"fixed",stack:"fixed"}).join(",");}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'standard-message-presence',
    source: 'function frames(error:Error){return Object.hasOwn(error,"message");}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'finite-safe-presence',
    source: 'function frames(error:Error,key:"message"|"plain"){return Object.hasOwn(error,key);}',
    refused: false,
    invocation: 'frames(new Error("ours"),"message")',
  },
  {
    id: 'omitted-presence-key',
    source:
      'function frames(error:Error){return (Object.hasOwn as (...args:unknown[])=>boolean)(error);}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'local-object-shadow',
    source:
      'function frames(error:Error){const Object={hasOwn:()=>true,getOwnPropertyNames:()=>["fixed"]};return Object.hasOwn(error,"fileName")&&Object.getOwnPropertyNames(error).length>0;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'local-error-class',
    source:
      'class Error{fileName="fixed";}function frames(error:Error){return Object.getOwnPropertyNames(error).join(",");}',
    refused: false,
    invocation: 'frames(new Error())',
  },
  {
    id: 'known-own-stack-presence',
    source:
      'class Failure extends Error{stack="fixed";}function frames(){return Object.hasOwn(new Failure("ours"),"stack");}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'written-own-has-property',
    source:
      'function frames(){const error=Object.assign(new Error("ours"),{hasOwnProperty:()=>true});return error.hasOwnProperty("fileName");}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'made-message-descriptor',
    source:
      'function frames(){return Object.getOwnPropertyDescriptors(new Error("ours")).message!.value;}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'safe-key-symbol',
    source: 'function frames(error:Error){return Object.hasOwn(error,Symbol.iterator);}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'safe-key-boolean',
    source: 'function frames(error:Error){return Object.hasOwn(error,false);}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'safe-key-null',
    source: 'function frames(error:Error){return Object.hasOwn(error,null);}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'safe-key-undefined',
    source: 'function frames(error:Error){return Object.hasOwn(error,undefined);}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
];

/** The observed actual compiler refusals, separate from the reader's classification. */
function recordObservation(source: string, reasons: readonly string[], refused: boolean): void {
  const observations = process.env['ERROR_SHAPE_OBSERVATIONS'];
  if (observations === undefined) return;
  appendFileSync(observations, `${JSON.stringify({ source, reasons, refused })}\n`);
}

describe('error-shape readers', () => {
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

describe('shared error-shape', () => {
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
    recordObservation(source, reasons, refused);

    expect(reasons.length > 0).toBe(refused);
  });
});
