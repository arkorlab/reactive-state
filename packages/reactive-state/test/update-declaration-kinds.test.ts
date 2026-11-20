import {
  type ArrowFunction,
  type FunctionExpression,
  isArrowFunction,
  isCallExpression,
  isFunctionExpression,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { analyzeComponent } from '../src/compiler/analyze.ts';
import { failIn } from '../src/compiler/errors.ts';
import type { HookDefinition } from '../src/compiler/hooks.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { readUpdate } from '../src/compiler/update.ts';
import { updaterId } from '../src/compiler/updaters.ts';

/**
 * What an update is named by: a hash of its owner, its state and its form. `let`, `const` and `var`
 * are a flag of the declaration list that holds them, not a child of it, so the form names the
 * kind: the same block with `var` for `let` computes another value where a block redeclares the
 * name, and is another update.
 */

/** The custom hooks the component calls, by the name they are imported as: none. */
const HOOKS: Partial<Record<string, HookDefinition>> = {};

/** A component of one state, `total`, whose handlers call `setTotal` with each of the updates. */
function componentOf(updates: readonly string[]): string {
  return [
    "import { useReactiveState } from 'framework/react';",
    '',
    'export default function Total({ step }: { step: number }) {',
    '  const [total, setTotal] = useReactiveState(0);',
    '  return (',
    '    <section>',
    ...updates.map((update) => `      <button onClick={() => setTotal(${update})} />`),
    '    </section>',
    '  );',
    '}',
    '',
  ].join('\n');
}

/** Each update's id, as a compile of the component registers it under the state `total`. */
function idsOf(updates: readonly string[]): readonly string[] {
  using api = openTypeScript();
  using parsed = parseModule(api, 'total.reactive.tsx', componentOf(updates));
  const { sourceFile } = parsed;
  const fail = failIn(sourceFile, 'total.reactive.tsx');
  const component = analyzeComponent({
    classify: () => ({ file: undefined, id: undefined, kind: 'package' }),
    fail,
    fileName: 'total.reactive.tsx',
    hookOf: (binding) => HOOKS[binding.exported],
    id: 'total',
    sourceFile,
  });
  const functions: (ArrowFunction | FunctionExpression)[] = [];
  const visit = (node: Node): void => {
    const call = node.parent;
    if (
      (isArrowFunction(node) || isFunctionExpression(node)) &&
      isCallExpression(call) &&
      call.expression.getText(sourceFile) === 'setTotal'
    ) {
      functions.push(node);
    }
    node.forEachChild(visit);
  };
  visit(component.declaration);

  expect(functions).toHaveLength(updates.length);

  return functions.map((fn) => {
    const update = readUpdate(fn, {
      captureType: () => 'number',
      declared: component.declared,
      declaring: component.declaring,
      fail,
      holdsFunction: () => false,
      names: component.names,
      sourceFile,
    });
    return updaterId('total', 'total', update.form);
  });
}

describe('the id of an update that declares', () => {
  it.each([
    {
      id: '`let` and `var` of a name a block declares again',
      updates: [
        '(n) => { let result = n; { let result = 0; } return result; }',
        '(n) => { var result = n; { var result = 0; } return result; }',
      ],
    },
    {
      id: '`let` and `const`',
      updates: ['(n) => { let r = n; return r + 1; }', '(n) => { const r = n; return r + 1; }'],
    },
    {
      id: '`const` and `var`',
      updates: ['(n) => { const r = n; return r + 1; }', '(n) => { var r = n; return r + 1; }'],
    },
    {
      id: '`using` and `const`',
      updates: [
        '(n) => { using r = open(n); return r.size + 1; }',
        '(n) => { const r = open(n); return r.size + 1; }',
      ],
    },
    {
      id: 'a declaration in a loop head',
      updates: [
        '(n) => { let sum = 0; for (let i = 0; i < n; i += 1) { sum += i; } return sum; }',
        '(n) => { let sum = 0; for (var i = 0; i < n; i += 1) { sum += i; } return sum; }',
      ],
    },
  ])('differs where only the kind of a declaration differs: $id', ({ updates }) => {
    const [first, second] = idsOf(updates);

    expect(first).not.toBe(second);
  });

  it.each([
    {
      id: 'the same kind, a parameter renamed',
      updates: ['(n) => { let r = n; return r + 1; }', '(m) => { let r = m; return r + 1; }'],
    },
    {
      id: 'the same kind, spaced otherwise',
      updates: [
        '(n) => { const r = n; return r + 1; }',
        '(n) => {\n const r = n;\n return r + 1;\n }',
      ],
    },
    {
      id: 'no declaration, a parameter renamed',
      updates: ['(n) => n + step', '(m) => m + step'],
    },
  ])('stays the same where the kind and the rest are: $id', ({ updates }) => {
    const [first, second] = idsOf(updates);

    expect(first).toBe(second);
  });

  it('stays apart where the values differ', () => {
    const [first, second] = idsOf([
      '(n) => { let r = n; return r; }',
      '(n) => { let r = n; return r + 1; }',
    ]);

    expect(first).not.toBe(second);
  });
});
