import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/** Native URI arguments and the selected replacement callback retain their consumed words. */
const CASES = [
  {
    id: 'destructured-holder-selected-raw',
    source:
      'function frames(error:Error){const {template}={raw:[],template:{raw:["",""]}};return String.raw(template,error as never);}',
    refused: true,
    invocation: 'frames(new Error("ours"))',
  },
  {
    id: 'unknown-spread-ignored-tail',
    source:
      'function frames(error:Error,parts:string[]){return String.raw({raw:["",""]},...parts,"fixed",error as never);}',
    refused: false,
    invocation: 'frames(new Error("ours"),[])',
  },
  {
    id: 'destructured-holder-fixed-data',
    source:
      'function frames(){const {template}={raw:[],template:{raw:["",""]}};return String.raw(template,"fixed");}',
    refused: false,
    invocation: 'frames()',
  },
  {
    id: 'fixed-prefix-unknown-ignored-tail',
    source:
      'function frames(error:Error,parts:string[]){return String.raw({raw:["",""]},"fixed",...parts,error as never);}',
    refused: false,
    invocation: 'frames(new Error("ours"),[])',
  },
];

describe('native raw followup readers', () => {
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

describe('shared native raw followup text', () => {
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
