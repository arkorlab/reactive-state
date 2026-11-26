import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** A known own encoder method does not convert arguments by native Web IDL rules. */
const CASES = [
  {
    id: 'own-encode-override',
    source:
      'function frames(error:Error){const encoder=new TextEncoder();encoder.encode=()=>new Uint8Array([1]);return encoder.encode(error as never)[0];}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'own-encode-into-override',
    source:
      'function frames(error:Error){const encoder=new TextEncoder();encoder.encodeInto=()=>({read:0,written:1});return encoder.encodeInto(error as never,new Uint8Array(1)).written;}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'own-computed-method',
    source:
      'function frames(error:Error){const encoder=new TextEncoder();encoder["encode"]=()=>new Uint8Array([1]);return encoder["encode"](error as never)[0];}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'own-alias-override',
    source:
      'function frames(error:Error){const encoder=new TextEncoder();const alias=encoder;alias.encode=()=>new Uint8Array([1]);return encoder.encode(error as never)[0];}',
    refused: false,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-borrow-after-override',
    source:
      'function frames(error:Error){const encoder=new TextEncoder();encoder.encode=()=>new Uint8Array([1]);return TextEncoder.prototype.encode.call(encoder,error as never)[0];}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'native-apply-after-override',
    source:
      'function frames(error:Error){const encoder=new TextEncoder();encoder.encode=()=>new Uint8Array([1]);return Reflect.apply(TextEncoder.prototype.encode,encoder,[error])[0];}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
];

describe('encoder override readers', () => {
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

describe('shared encoder overrides', () => {
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
