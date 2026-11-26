import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Present reduction elements and native fill bounds preserve selected result origins. */
const CASES = [
  {
    id: 'reduce-sole-present-error',
    source: 'function frames(error:Error){return([,,error]as Error[]).reduce(value=>value).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reduce-right-sole-present-error',
    source:
      'function frames(error:Error){return([error,,,]as Error[]).reduceRight(value=>value).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reduce-last-present-error',
    source:
      'function frames(error:Error){return([{stack:"fixed"},error,,]as(Error|{stack:string})[]).reduce((_acc,value)=>value).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reduce-right-first-present-error',
    source:
      'function frames(error:Error){return([,,error,{stack:"fixed"}]as(Error|{stack:string})[]).reduceRight((_acc,value)=>value).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'reduce-sole-data-skips-error-callback',
    source:
      'function frames(error:Error){return([,,{stack:"fixed"}]as(Error|{stack:string})[]).reduce(()=>error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'reduce-right-sole-data-skips-error-callback',
    source:
      'function frames(error:Error){return([{stack:"fixed"},,,]as(Error|{stack:string})[]).reduceRight(()=>error).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'reduce-hole-array-keeps-initial-data',
    source:
      'function frames(error:Error){return([,,]as unknown as(Error|{stack:string})[]).reduce(()=>error,{stack:"fixed"}).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'reduce-dense-final-data',
    source:
      'function frames(error:Error){return[error,{stack:"fixed"}].reduce((_acc,value)=>value).stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'fill-equal-range',
    source:
      'function frames(error:Error){const values:unknown[]=[0];values.fill(error,1,1);return values.join(",");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'fill-start-past-end',
    source:
      'function frames(error:Error){const values:unknown[]=[0];values.fill(error,2);return values.join(",");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'fill-equal-negative-range',
    source:
      'function frames(error:Error){const values:unknown[]=[0];values.fill(error,-1,-1);return values.join(",");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'fill-end-zero',
    source:
      'function frames(error:Error){const values:unknown[]=[0];values.fill(error,0,0);return values.join(",");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'fill-nonempty-range',
    source:
      'function frames(error:Error){const values:unknown[]=[0];values.fill(error,0,1);return values.join(",");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'fill-unknown-range',
    source:
      'function frames(error:Error,start:number){const values:unknown[]=[0];values.fill(error,start);return values.join(",");}',
    invocation: 'frames(new Error("ours"),0)',
    refused: true,
  },
  {
    id: 'fill-prior-growth',
    source:
      'function frames(error:Error){const values:unknown[]=[0];values.push(0);values.fill(error,1);return values.join(",");}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'fill-borrowed-equal-range',
    source:
      'function frames(error:Error){const values:unknown[]=[0];Array.prototype.fill.call(values,error,1,1);return values.join(",");}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'fill-opaque-own-noop-not-native',
    source:
      'function frames(error:Error,change:(this:unknown[],value:unknown)=>unknown[]){const values:unknown[]=[0];values.fill=change;values.fill(error,1,1);return values.join(",");}',
    invocation:
      'frames(new Error("ours"),function(this:unknown[],value:unknown){this[0]=value;return this;})',
    refused: true,
  },
];

describe('sparse reduction and fill readers', () => {
  it.each(CASES)('$id', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'projected-array.ts', source);
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

describe('sparse reduction and fill shared helpers', () => {
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

    expect(reasons).toStrictEqual(refused ? [shared] : []);
  });
});
