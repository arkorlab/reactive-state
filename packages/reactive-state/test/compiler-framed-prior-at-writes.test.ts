import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';
/** Native at retains reachable inserted errors while exact unrelated positions remain data. */
const CASES = [
  {
    group: 'at',
    id: 'at-push',
    source:
      'function frames(error:Error){const values:unknown[]=[];values.push(error);return values.at(0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'at',
    id: 'at-index-write',
    source:
      'function frames(error:Error){const values:unknown[]=[];values[0]=error;return values.at(0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'at',
    id: 'at-unshift',
    source:
      'function frames(error:Error){const values:unknown[]=[];values.unshift(error);return values.at(0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'at',
    id: 'at-borrowed',
    source:
      'function frames(error:Error){const values:unknown[]=[];values.push(error);return Array.prototype.at.call(values,0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    group: 'at',
    id: 'at-data-write',
    source:
      'function frames(error:Error){const values:unknown[]=[];values.push({stack:"data"});return values.at(0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'at',
    id: 'at-after-read',
    source:
      'function frames(error:Error){const values=[{stack:"fixed"}];const result=values.at(0)!.stack;values.push(error);return result;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'at',
    id: 'at-unrelated-index',
    source:
      'function frames(error:Error){const values:unknown[]=[{stack:"fixed"}];values[1]=error;return values.at(0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'at',
    id: 'at-own-data',
    source:
      'function frames(error:Error){const values:unknown[]=[];values.push(error);values.at=()=>({stack:"data"});return values.at(0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'at',
    id: 'at-false-branch',
    source:
      'function frames(error:Error){const values:unknown[]=[{stack:"fixed"}];if(false)values.push(error);return values.at(0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    group: 'at',
    id: 'at-local-made-words',
    source:
      'function frames(){const values:unknown[]=[];values.push(new Error("ours"));return values.at(0)!.message;}',
    invocation: 'frames()',
    refused: false,
  },
  {
    group: 'at',
    id: 'at-local-made-frames',
    source:
      'function frames(){const values:unknown[]=[];values.push(new Error("ours"));return values.at(0)!.stack;}',
    invocation: 'frames()',
    refused: true,
  },
  {
    group: 'at',
    id: 'at-shifted-index-write',
    source:
      'function frames(error:Error){const values:unknown[]=[{stack:"fixed"}];values[1]=error;values.shift();return values.at(0)!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
] as const;

describe('source-written at readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'source-writes.ts', source);
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

describe('source-written at shared modules', () => {
  const { apps, compile } = compilerApplications();

  it.each(CASES)('$id', async ({ source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
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
