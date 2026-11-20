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
 * What an update is named by: the id of the updater a setter's call registers is a hash of the
 * component, the state and the update's form, so two updates of one state that compute different
 * values must differ in their form — the authority keeps one registered update under each id, and
 * a call names it.
 */

/** The custom hooks the component calls, by the name they are imported as: none. */
const HOOKS: Partial<Record<string, HookDefinition>> = {};

/** A component of two props, `step` and `other`, whose `setTotal` calls hold the updates. */
function componentOf(updates: readonly string[]): string {
  return [
    "import { useReactiveState } from 'framework/react';",
    '',
    'export default function Total({ step, other }: { step: number; other: number }) {',
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

describe('the id of an update', () => {
  it.each([
    {
      id: 'two shorthand properties, each named as its parameter',
      updates: ['(left) => ({ left })', '(right) => ({ right })'],
    },
    {
      id: 'two shorthand properties of the parameter, each with a spread of it',
      updates: ['(left) => ({ ...left, left })', '(right) => ({ ...right, right })'],
    },
    {
      id: 'two shorthand properties of the parameter, in a function expression',
      updates: ['function (left) { return { left }; }', 'function (right) { return { right }; }'],
    },
    {
      id: 'two shorthand properties of the parameter, in a nested object',
      updates: ['(left) => ({ box: { left } })', '(right) => ({ box: { right } })'],
    },
  ])('differs where two updates differ in the key of a shorthand property: $id', ({ updates }) => {
    const [first, second] = idsOf(updates);

    expect(first).not.toBe(second);
  });

  it.each([
    {
      id: 'a shorthand property beside a longhand one of another key',
      updates: ['(left) => ({ left })', '(left) => ({ right: left })'],
    },
    {
      id: 'a shorthand property of the parameter beside one of a capture',
      updates: ['(current) => ({ current })', '(current) => ({ step })'],
    },
    {
      id: 'two shorthand properties of two captures',
      updates: ['(current) => ({ step })', '(current) => ({ other })'],
    },
  ])('stays apart where two updates differ otherwise: $id', ({ updates }) => {
    const [first, second] = idsOf(updates);

    expect(first).not.toBe(second);
  });

  it.each([
    {
      id: 'a parameter renamed, the property written with its key',
      updates: ['(key) => ({ key: key })', '(second) => ({ key: second })'],
    },
    {
      id: 'a shorthand property of the same key, written twice',
      updates: ['(left) => ({ left })', '(left) => ({ left })'],
    },
    {
      id: 'a shorthand property of a capture, written with another spacing',
      updates: ['(current) => ({ step })', '(value) =>   ( { step } )'],
    },
    {
      id: 'an update of no object, a parameter renamed',
      updates: ['(count) => count + step', '(sum) => sum + step'],
    },
  ])('stays the same where two updates compute alike: $id', ({ updates }) => {
    const [first, second] = idsOf(updates);

    expect(first).toBe(second);
  });
});
