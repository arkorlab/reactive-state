import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A known own encoder method does not convert arguments by native Web IDL rules. */
const CASES = [
  {
    id: 'own-accessor-interception',
    source:
      "function frames(error:Error){const encoder=new TextEncoder();Object.defineProperty(encoder,'encode',{set(_value){},get(){return TextEncoder.prototype.encode;}});encoder.encode=()=>new Uint8Array([1]);return encoder.encode(error as never)[0];}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'same-owner-exposure',
    source:
      "function frames(error:Error){const encoder=new TextEncoder();function expose(value:TextEncoder){Object.defineProperty(value,'encode',{set(_value){},get(){return TextEncoder.prototype.encode;}});}expose(encoder);encoder.encode=()=>new Uint8Array([1]);return encoder.encode(error as never)[0];}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'cross-owner-hoisted-exposure',
    source:
      "function frames(error:Error){const encoder=new TextEncoder();touch();encoder.encode=()=>new Uint8Array([1]);return encoder.encode(error as never)[0];function touch(){Object.defineProperty(encoder,'encode',{set(_value){},get(){return TextEncoder.prototype.encode;}});}}",
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'separate-shadow-owner-data',
    source:
      'function frames(error:Error){const encoder=new TextEncoder();function touch(){const encoder={encode:0};return encoder.encode;}touch();encoder.encode=()=>new Uint8Array([1]);return encoder.encode(error as never)[0];}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'whole-const-alias-chain-data',
    source:
      'function frames(error:Error){const encoder=new TextEncoder();const first=encoder;const second=first;second.encode=()=>new Uint8Array([1]);return encoder.encode(error as never)[0];}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'ordinary-conversion-data',
    source:
      'function frames(){const encoder=new TextEncoder();Object.defineProperty(encoder,"encode",{set(_value){},get(){return TextEncoder.prototype.encode;}});encoder.encode=()=>new Uint8Array([1]);return encoder.encode("fixed")[0];}',
    invocation: 'frames()',
    refused: false,
  },
];

describe('encoder accessor readers', () => {
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

describe('shared encoder accessors', () => {
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
