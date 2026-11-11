import { type Expression, isCallExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayString, framedArrayText } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A statement's operands run before its own write: a write nested in a mutator call's arguments
 * comes before the method the call installs, which still holds.
 */
const NATIVE = 'values.join = Array.prototype.join';

const CASES = [
  {
    id: 'reviewed-assign-argument',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: (${NATIVE}), join: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'define-property-argument',
    source: `function frames(error: Error) { const values = [error]; Object.defineProperty(values, 'join', { enumerable: ((${NATIVE}), false), value: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'accessor-argument',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: Object.defineProperty(values, 'join', { get: () => Array.prototype.join, set: () => {} }), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'data-definition-argument',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: Object.defineProperty(values, 'join', { value: Array.prototype.join }), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'definitions-argument',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: Object.defineProperties(values, { join: { get: () => Array.prototype.join, set: () => {} } }), join: () => 'safe' }); return String(values); }`,
    converts: true,
  },
  {
    id: 'other-key-definition-pin',
    source: `function frames(error: Error) { const values = [error]; Object.assign(values, { ignored: Object.defineProperty(values, 'label', { value: 1 }), join: () => 'safe' }); return String(values); }`,
    converts: false,
  },
  {
    id: 'other-field-argument-pin',
    source: `function frames(error: Error) { const values = [error]; values.join = () => 'safe'; Object.assign(values, { label: ((${NATIVE}), 1) }); return String(values); }`,
    converts: true,
  },
  {
    id: 'later-statement-pin',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; Object.assign(values, { join: () => 'safe' }); flag && (${NATIVE}); return String(values); }`,
    converts: true,
  },
] as const;

describe('writes a definite method write evaluates first', () => {
  it.each(CASES)('$id', ({ source, converts }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'argument-write-order.ts', source);

    expect(convertsError(parsed.sourceFile)).toBe(converts);
  });
});

/** Whether a native join, toString or String call in the source converts the `error` element. */
function convertsError(root: Node): boolean {
  const words = {
    error: (value: Expression, keys?: readonly string[]) => {
      const each = unwrapped(value);
      return (
        (keys === undefined || keys.length === 0) && isIdentifier(each) && each.text === 'error'
      );
    },
    typed: () => false,
  };
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedArrayText(node, words)) return true;
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === 'String' &&
      framedArrayString(node.arguments[0], words, node)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}
