import {
  type BinaryExpression,
  type Expression,
  isArrayLiteralExpression,
  isBinaryExpression,
  isElementAccessExpression,
  isIdentifier,
  isVariableDeclaration,
  type Node,
  SyntaxKind,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedLogicalElementSkipped } from '../src/compiler/framed-array-logical-writes.ts';
import { type FrameBinding, frameBindingOf } from '../src/compiler/framed-bindings.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A logical assignment reads the initial slot of `root` only when it writes an element of that
 * array: the receiver of its target is the array, by the name of `root` or of a constant alias of
 * it, and not a member, an element or a result of one, or any other array. Its caller passes only
 * such assignments, and the answer for any other is that the right side runs. `grid[0][0] ||= g()`
 * is the element `0` of `grid[0]`, which is `0` here, so `g()` runs.
 */
const DECLARATION = 'declare function g(): number; declare function rows(): number[];';

const CASES = [
  {
    id: 'element-of-an-element',
    root: 'grid',
    source: `${DECLARATION} const grid = [[0]]; grid[0][0] ||= g();`,
    skipped: false,
  },
  {
    id: 'element-of-an-element-asserted-present',
    root: 'grid',
    source: `${DECLARATION} const grid = [[0]]; grid[0]![0] ||= g();`,
    skipped: false,
  },
  {
    id: 'element-of-an-element-cast',
    root: 'grid',
    source: `${DECLARATION} const grid = [[0]]; (grid[0] as number[])[0] ||= g();`,
    skipped: false,
  },
  {
    id: 'element-of-a-constant-holding-an-element',
    root: 'grid',
    source: `${DECLARATION} const grid = [[0]]; const row = grid[0]; row[0] ||= g();`,
    skipped: false,
  },
  {
    id: 'element-of-an-element-of-an-and-assignment',
    root: 'grid',
    source: `${DECLARATION} const grid = [[1]]; grid[0][0] &&= g();`,
    skipped: false,
  },
  {
    id: 'element-of-another-array',
    root: 'grid',
    source: `${DECLARATION} const grid = [1]; const other = [0]; other[0] ||= g();`,
    skipped: false,
  },
  {
    id: 'element-of-another-array-of-an-and-assignment',
    root: 'grid',
    source: `${DECLARATION} const grid = [0]; const other = [1]; other[0] &&= g();`,
    skipped: false,
  },
  {
    id: 'element-of-an-array-literal',
    root: 'grid',
    source: `${DECLARATION} const grid = [1]; [0][0] ||= g();`,
    skipped: false,
  },
  {
    id: 'element-of-a-call-result',
    root: 'grid',
    source: `${DECLARATION} const grid = [1]; rows()[0] ||= g();`,
    skipped: false,
  },
  {
    id: 'element-of-a-member',
    root: 'grid',
    source: `${DECLARATION} const grid = [1]; ({ own: [0] }).own[0] ||= g();`,
    skipped: false,
  },
  {
    id: 'element-of-a-conditional-array',
    root: 'grid',
    source: `${DECLARATION} const grid = [1]; const other = [0]; (g() ? grid : other)[0] ||= g();`,
    skipped: false,
  },
  {
    id: 'plain-receiver-pin',
    root: 'grid',
    source: `${DECLARATION} const grid = [1]; grid[0] ||= g();`,
    skipped: true,
  },
  {
    id: 'parenthesized-receiver-pin',
    root: 'grid',
    source: `${DECLARATION} const grid = [1]; (grid)[0] ||= g();`,
    skipped: true,
  },
  {
    id: 'cast-receiver-pin',
    root: 'grid',
    source: `${DECLARATION} const grid = [1]; (grid as number[])[0] ||= g();`,
    skipped: true,
  },
  {
    id: 'asserted-present-receiver-pin',
    root: 'grid',
    source: `${DECLARATION} const grid = [1]; grid![0] ||= g();`,
    skipped: true,
  },
  {
    id: 'comma-receiver-pin',
    root: 'grid',
    source: `${DECLARATION} const grid = [1]; (0, grid)[0] ||= g();`,
    skipped: true,
  },
  {
    id: 'constant-alias-receiver-pin',
    root: 'grid',
    source: `${DECLARATION} const grid = [1]; const alias = grid; alias[0] ||= g();`,
    skipped: true,
  },
  {
    id: 'constant-alias-of-an-alias-receiver-pin',
    root: 'grid',
    source: `${DECLARATION} const grid = [1]; const first = grid; const second = first; second[0] ||= g();`,
    skipped: true,
  },
  {
    id: 'alias-written-first-pin',
    root: 'grid',
    source: `${DECLARATION} const grid = [1]; const alias = grid; alias[0] = 0; alias[0] ||= g();`,
    skipped: false,
  },
];

const LOGICAL: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** Every node of `root`'s tree. */
function nodesOf(root: Node): readonly Node[] {
  const nodes: Node[] = [];
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    nodes.push(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return nodes;
}

/** The logical assignment of an element of `root`, the one such. */
function logicalWrite(root: Node): BinaryExpression {
  const writes = nodesOf(root).filter((node): node is BinaryExpression => {
    return (
      isBinaryExpression(node) &&
      LOGICAL.has(node.operatorToken.kind) &&
      isElementAccessExpression(unwrapped(node.left))
    );
  });
  const [write] = writes;
  if (write === undefined || writes.length !== 1) throw new Error('no single logical write');
  return write;
}

/** The variable `name` the source declares. */
function variableNamed(root: Node, name: string): FrameBinding {
  for (const node of nodesOf(root))
    if (isVariableDeclaration(node) && isIdentifier(node.name) && node.name.text === name)
      return node;
  throw new Error(`no ${name}`);
}

/** The variable a name comes to by constant aliases, as the caller of the analysis follows it. */
function arrayVariable(node: Expression): FrameBinding | undefined {
  let value = unwrapped(node);
  let root: FrameBinding | undefined;
  const seen = new Set<FrameBinding>();
  while (isIdentifier(value)) {
    const selected = frameBindingOf(value);
    if (selected === undefined || selected.keys.length > 0 || seen.has(selected.binding))
      return undefined;
    root = selected.binding;
    seen.add(root);
    if (root.initializer === undefined) return undefined;
    value = unwrapped(root.initializer);
  }
  return isArrayLiteralExpression(value) ? root : undefined;
}

describe('whether a logical assignment of another array or an element of one reads the initial slot', () => {
  it.each(CASES)('$id', ({ source, root: name, skipped }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'logical-receivers.ts', source);
    const write = logicalWrite(parsed.sourceFile);
    const root = variableNamed(parsed.sourceFile, name);

    expect(framedLogicalElementSkipped(write, root, (value) => arrayVariable(value) === root)).toBe(
      skipped,
    );
  });
});
