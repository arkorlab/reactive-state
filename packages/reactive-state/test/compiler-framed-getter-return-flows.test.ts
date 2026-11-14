import { type Expression, isExpressionStatement, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedObjectSources } from '../src/compiler/framed-object-members.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A written getter's value is what its body returns. Where the compile follows the body's flow it
 * keeps the returns that flow reaches; where it does not, a statement it has no rule for stands
 * between them, and every written `return` of the getter's own is a possible value, as it is of a
 * written function. A getter shown to return nothing selects nothing.
 */
const CASES = [
  {
    id: 'reviewed-expression-statement',
    source: '({ get value() { void 0; return error; } })',
    sources: ['error:'],
  },
  {
    id: 'let-held-value',
    source: '({ get value() { let held = error; return held; } })',
    sources: ['held:'],
  },
  {
    id: 'try-returns',
    source: '({ get value() { try { return error; } catch { return other; } } })',
    sources: ['error:', 'other:'],
  },
  {
    id: 'loop-returns',
    source: '({ get value() { for (const each of []) { return each; } return error; } })',
    sources: ['each:', 'error:'],
  },
  {
    id: 'branch-returns-after-effect',
    source: '({ get value() { void 0; if (flag) return error; return other; } })',
    sources: ['error:', 'other:'],
  },
  {
    id: 'later-data-field-replaces-pin',
    source: '({ get value() { void 0; return error; }, value: other })',
    sources: ['other:'],
  },
  {
    id: 'nested-function-return-is-its-own',
    source: '({ get value() { void 0; const read = () => { return other; }; return error; } })',
    sources: ['error:'],
  },
  {
    id: 'followed-branches-pin',
    source: '({ get value() { if (flag) return error; return other; } })',
    sources: ['error:', 'other:'],
  },
  {
    id: 'followed-known-condition-pin',
    source: '({ get value() { if (false) return error; return other; } })',
    sources: ['other:'],
  },
  {
    id: 'no-return-pin',
    source: '({ get value() { void 0; } })',
    sources: [],
  },
  {
    id: 'bare-return-pin',
    source: '({ get value() { void 0; return; } })',
    sources: [],
  },
] as const;

describe('values a written getter may return', () => {
  it.each(CASES)('$id', ({ source, sources }) => {
    expect(selected(source)).toStrictEqual(sources);
  });
});

/** The sources the literal's `value` member may select, in text order. */
function selected(source: string): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(
    api,
    'getter-return-flows.ts',
    `declare const error: Error; declare const other: Error; declare const flag: boolean; ${source};`,
  );
  return framedObjectSources(statement(parsed.sourceFile), ['value'])
    ?.map((each) => `${each.value.getText()}:${each.keys.join('.')}`)
    .toSorted((left, right) => left.localeCompare(right));
}

function statement(root: Node): Expression {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isExpressionStatement(node)) return node.expression;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no statement');
}
