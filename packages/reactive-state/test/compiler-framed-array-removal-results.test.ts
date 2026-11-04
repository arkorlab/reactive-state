import { appendFileSync } from 'node:fs';

import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native result sources retain selected Error identity and locally written data. */
const CASES = [
  {
    id: 'pop-error',
    source: 'function frames(error:Error){return [error].pop()!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'shift-error',
    source: 'function frames(error:Error){return [error].shift()!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'typed-pop',
    source: 'function frames(values:Error[]){return values.pop()!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'typed-shift',
    source: 'function frames(values:Error[]){return values.shift()!.stack;}',
    invocation: 'frames([new Error("ours")])',
    refused: true,
  },
  {
    id: 'pop-selected-data',
    source: 'function frames(error:Error){return [error,{stack:"fixed"}].pop()!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'shift-selected-data',
    source: 'function frames(error:Error){return [{stack:"fixed"},error].shift()!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-pop-data',
    source:
      'function frames(error:Error){const values=[error];values.pop=()=>({stack:"fixed",name:"fixed",message:"fixed"});return values.pop()!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-shift-data',
    source:
      'function frames(error:Error){const values=[error];values.shift=()=>({stack:"fixed",name:"fixed",message:"fixed"});return values.shift()!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'own-pop-error',
    source:
      'function frames(error:Error){const values:unknown[]=[{stack:"fixed"}];values.pop=()=>error;return (values.pop() as Error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'local-pop-words',
    source: 'function frames(){return [new Error("ours")].pop()!.message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'local-shift-words',
    source: 'function frames(){return [new Error("ours")].shift()!.message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'borrowed-pop',
    source: 'function frames(error:Error){return Array.prototype.pop.call([error]).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'borrowed-shift',
    source:
      'function frames(error:Error){return Reflect.apply(Array.prototype.shift,[error],[]).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
];

function record(id: string, reasons: readonly string[]): void {
  const file = process.env['NATIVE_RESULT_OBSERVATIONS'];
  if (file !== undefined) appendFileSync(file, `${JSON.stringify({ id, reasons })}\n`);
}

describe('array-removal-results readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'tuple-iteration.ts', source);
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

describe('shared array-removal-results', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ id, source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    record(id, reasons);
    const shared = expect.stringContaining('a shared module that answers otherwise');

    expect(reasons).toStrictEqual(refused ? [shared] : []);
  });
});
