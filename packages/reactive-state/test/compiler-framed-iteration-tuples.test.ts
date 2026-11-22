import { appendFileSync } from 'node:fs';

import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Finite required iteration tuples retain every possible selected source position. */
const CASES = [
  {
    id: 'tuple-later-error-words',
    source:
      'type Sources=[{stack:string},Exclude<Error,string>];function frames(error:Error){const inputs:Sources=[{stack:"fixed"},error];const values:unknown[]=[{stack:"fixed"}];for(values[0] of inputs){}return String(values[0]);}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'generic-tuple-parameter',
    source:
      'type Slots<T>=[{stack:string},T];function frames(inputs:Slots<Error>){const values:unknown[]=["fixed"];for(values[0] of inputs){}return values.join();}',
    invocation: 'frames([{stack:"fixed"},new Error("ours")])',
    refused: true,
  },
  {
    id: 'nested-pattern-tuple',
    source:
      'type Slots=[readonly[{stack:string}],readonly[Error]];function frames(inputs:Slots){const values:unknown[]=["fixed"];for([values[0]] of inputs){}return values.join();}',
    invocation: 'frames([[{stack:"fixed"}],[new Error("ours")]])',
    refused: true,
  },
  {
    id: 'readonly-required-tuple',
    source:
      'function frames(inputs:readonly[{stack:string},Error]){let selected:unknown="fixed";for(selected of inputs){}return String(selected);}',
    invocation: 'frames([{stack:"fixed"},new Error("ours")])',
    refused: true,
  },
  {
    id: 'tuple-all-data',
    source:
      'type Value=Exclude<Error,{}>|{stack:string};type Sources=[{stack:string},Value];function frames(){const inputs:Sources=[{stack:"fixed"},{stack:"fixed"}];const values:unknown[]=[{stack:"fixed"}];for(values[0] of inputs){}return String(values[0]);}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'empty-declared-tuple',
    source:
      'function frames(){const inputs:[]=[];const values:unknown[]=["fixed"];for(values[0] of inputs){}return values.join();}',
    invocation: 'frames()',
    refused: false,
  },
  {
    id: 'empty-literal-loop',
    source:
      'function frames(error:Error){const values:unknown[]=["fixed"];for(values[0] of []){}return values.join();}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'unselected-tuple-loop',
    source:
      'function frames(inputs:[string,Error]){const values:unknown[]=["fixed"];if(false){for(values[0] of inputs){}}return values.join();}',
    invocation: 'frames(["fixed",new Error("ours")])',
    refused: false,
  },
  {
    id: 'optional-empty-boundary',
    source:
      'function frames(){const inputs:[{stack:string}?,Error?]=[];const values:unknown[]=["fixed"];for(values[0] of inputs){}return values.join();}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'rest-data-boundary',
    source:
      'function frames(){const inputs:[{stack:string},...Error[]]=[{stack:"fixed"}];const values:unknown[]=["fixed"];for(values[0] of inputs){}return values.join();}',
    invocation: 'frames()',
    refused: true,
  },
  {
    id: 'declaration-target-shadow',
    source:
      'function frames(inputs:[string,Error]){const selected="fixed";for(const selected of inputs){void selected;}return selected;}',
    invocation: 'frames(["fixed",new Error("ours")])',
    refused: false,
  },
  {
    id: 'local-error-type-data',
    source:
      'type Error={stack:string};function frames(inputs:[string,Error]){const values:unknown[]=["fixed"];for(values[0] of inputs){}return values.join();}',
    invocation: 'frames(["fixed",{stack:"fixed"}])',
    refused: false,
  },
];

function record(id: string, reasons: readonly string[]): void {
  const file = process.env['TUPLE_ITERATION_OBSERVATIONS'];
  if (file !== undefined) appendFileSync(file, `${JSON.stringify({ id, reasons })}\n`);
}

describe('required tuple iteration readers', () => {
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

describe('shared required tuple iteration', () => {
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
