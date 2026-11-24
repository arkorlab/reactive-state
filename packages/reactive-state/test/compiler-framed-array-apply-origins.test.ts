import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';
import { arrayResultCases } from './support/framed-array-origin-cases.ts';

const rows = arrayResultCases.filter((row) => row.group === 'apply');

describe('native array apply source origins', () => {
  const { apps, compile } = compilerApplications();

  it.each(rows)('$id reader', (row) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'array-origins.ts', row.source);

    expect(readsFrames(parsed.sourceFile)).toBe(row.reader);
  });

  it.each(rows)('$id actual shared', async (row) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type {TodoFilter} from '@/navigation';",
        row.source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${row.invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((item) => item.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');
    const expected = row.refused ? [shared] : [];

    expect(reasons).toStrictEqual(expected);
  });
});

function readsFrames(root: Node): boolean {
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
