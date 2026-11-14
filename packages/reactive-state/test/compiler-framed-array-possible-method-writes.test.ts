import { type Expression, isCallExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayString, framedArrayText } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A custom text method's proof holds only while no write may replace the method before the read: a
 * write in an earlier statement's branch or operand, in the read's own statement, or in a function
 * that may run before the read. A write the code shows cannot run first leaves the proof.
 */
const SAFE = "values.join = () => 'safe';";
const NATIVE = 'values.join = Array.prototype.join;';

const CASES = [
  {
    id: 'reviewed-prior-branch',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; ${SAFE} if (flag) ${NATIVE} return String(values); }`,
    converts: true,
  },
  {
    id: 'logical-operand',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; ${SAFE} flag && (${NATIVE.slice(0, -1)}); return String(values); }`,
    converts: true,
  },
  {
    id: 'logical-assignment',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} values.join &&= Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'loop-body',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} for (const each of [1]) ${NATIVE} return values.join(','); }`,
    converts: true,
  },
  {
    id: 'hoisted-function-called',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} restore(); return String(values); function restore() { ${NATIVE} } }`,
    converts: true,
  },
  {
    id: 'arrow-called',
    source: `function frames(error: Error) { const values = [error]; const restore = () => { ${NATIVE} }; ${SAFE} restore(); return String(values); }`,
    converts: true,
  },
  {
    id: 'read-statement-operand',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return (${NATIVE.slice(0, -1)}, String(values)); }`,
    converts: true,
  },
  {
    id: 'proof-after-branch-refused',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; if (flag) ${NATIVE} ${SAFE} return String(values); }`,
    converts: true,
  },
  {
    id: 'unreferenced-function-refused',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return String(values); function unused() { ${NATIVE} } }`,
    converts: true,
  },
  {
    id: 'dead-branch-refused',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} if (false) ${NATIVE} return String(values); }`,
    converts: true,
  },
  {
    id: 'other-array-branch-refused',
    source: `function frames(error: Error, flag: boolean) { const values = [error]; const other = [1]; ${SAFE} if (flag) other.join = Array.prototype.join; return String(values); }`,
    converts: true,
  },
  {
    id: 'later-in-read-statement-refused',
    source: `function frames(error: Error) { const values = [error]; ${SAFE} return [String(values), ${NATIVE.slice(0, -1)}][0]; }`,
    converts: true,
  },
] as const;

describe('array text methods a possible write replaces', () => {
  it.each(CASES)('$id', ({ source, converts }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'possible-method-writes.ts', source);

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
