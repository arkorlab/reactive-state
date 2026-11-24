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
    id: 'prior-reverse-pop',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];values.reverse();return values.pop()!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'unchanged-const-alias',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];const alias=values;return alias.pop()!.stack;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
  {
    id: 'removal-default-source-reverse',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];const {a=values.pop()!.stack}=(values.reverse(),{} as {a?:string});return a;}',
    invocation: 'frames(new Error("ours"))',
    refused: true,
  },
  {
    id: 'removal-default-source-other',
    source:
      'function frames(error:Error){const values=[error,{stack:"fixed"}];const other=[0,1];const {a=values.pop()!.stack}=(other.reverse(),{} as {a?:string});return a;}',
    invocation: 'frames(new Error("ours"))',
    refused: false,
  },
];

function record(id: string, reasons: readonly string[]): void {
  const file = process.env['REMOVAL_POSITION_OBSERVATIONS'];
  if (file !== undefined) appendFileSync(file, `${JSON.stringify({ id, reasons })}\n`);
}

describe('removal position review readers', () => {
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

describe('shared removal position review', () => {
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
