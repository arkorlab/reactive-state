import type { Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { application } from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';
import { framedNativeValueCases } from './support/framed-native-value-cases.ts';

describe('native fulfillment and entry values', () => {
  const { apps, compile } = compilerApplications();

  it.each(framedNativeValueCases)('$id reader', ({ source, refused }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'native-values.ts', source);

    expect(readsFrames(parsed.sourceFile)).toBe(refused);
  });

  it.each(framedNativeValueCases)('$id actual shared', async ({ source, invocation, refused }) => {
    const app = await application({
      'domain/todo-filter.ts': [
        "import type { TodoFilter } from '@/navigation';",
        source,
        `export function normalizeFilter(value:string):TodoFilter{return String(${invocation}).length>40?'all':value==='active'||value==='done'?value:'all';}`,
      ].join('\n'),
    });
    apps.push(app);
    const reasons = compile(app).refusals.map((refusal) => refusal.reason);
    const shared = expect.stringContaining('a shared module that answers otherwise');

    expect(reasons).toStrictEqual(refused ? [shared] : []);
  });
});

function readsFrames(root: Node): boolean {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node) !== undefined) return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
