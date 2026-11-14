import { type CallExpression, isCallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedAppliedArguments } from '../src/compiler/framed-keys.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Work between a captured tuple and the native call that reads it runs the application's code
 * without a call written: a template's conversion or tag, a decorator, which count as calls; and an
 * operator's conversion, a computed key, a wait, a spread's or a pattern's getters and iteration,
 * which change the tuple only where code they may run reaches it — `swap`'s methods below, written
 * before the tuple, name it.
 */
const STATED = "const tuple = [{}, 'stack'];";
const READ = 'Reflect.get.apply(null, tuple);';
const WRITE = 'tuple[0] = new Error();';

const CASES = [
  {
    id: 'template-conversion',
    source: `const swap = { toString() { ${WRITE} return ''; } }; ${STATED} void \`\${swap}\`; ${READ}`,
    entries: undefined,
  },
  {
    id: 'template-tag',
    source: `function swap(..._parts: unknown[]) { ${WRITE} return ''; } ${STATED} swap\`\`; ${READ}`,
    entries: undefined,
  },
  {
    id: 'decorator',
    source: `function swap(value: unknown) { ${WRITE} return value; } ${STATED} @swap class Swapped {} void Swapped; ${READ}`,
    entries: undefined,
  },
  {
    id: 'unary-conversion',
    source: `const swap = { valueOf() { ${WRITE} return 0; } }; ${STATED} void +swap; ${READ}`,
    entries: undefined,
  },
  {
    id: 'binary-conversion',
    source: `const swap = { valueOf() { ${WRITE} return 0; } }; ${STATED} const sum = (swap as unknown as number) + 1; void sum; ${READ}`,
    entries: undefined,
  },
  {
    id: 'computed-key',
    source: `const swap = { toString() { ${WRITE} return 'key'; } }; ${STATED} void { [swap as unknown as string]: 1 }; ${READ}`,
    entries: undefined,
  },
  {
    id: 'awaited-thenable',
    source: `async function frames() { const swap = { then(resolve: (value: number) => void) { ${WRITE} resolve(0); } }; ${STATED} await swap; return ${READ} }`,
    entries: undefined,
  },
  {
    id: 'array-spread',
    source: `const swap = { *[Symbol.iterator]() { ${WRITE} } }; ${STATED} void [...swap]; ${READ}`,
    entries: undefined,
  },
  {
    id: 'object-spread',
    source: `const swap = { get x() { ${WRITE} return 0; } }; ${STATED} void { ...swap }; ${READ}`,
    entries: undefined,
  },
  {
    id: 'for-of-iteration',
    source: `const swap = { *[Symbol.iterator]() { ${WRITE} } }; ${STATED} for (const each of swap) void each; ${READ}`,
    entries: undefined,
  },
  {
    id: 'destructured-getter',
    source: `const swap = { get x() { ${WRITE} return 0; } }; ${STATED} const { x } = swap; void x; ${READ}`,
    entries: undefined,
  },
  {
    id: 'in-trap',
    source: `const swap = new Proxy({}, { has() { ${WRITE} return true; } }); ${STATED} void ('x' in swap); ${READ}`,
    entries: undefined,
  },
  {
    id: 'instanceof-hook',
    source: `const swap = { [Symbol.hasInstance]() { ${WRITE} return true; } }; ${STATED} void ({} instanceof (swap as unknown as Function)); ${READ}`,
    entries: undefined,
  },
  {
    id: 'jsx-spread',
    source: `const swap = { get x() { ${WRITE} return 0; } }; ${STATED} void <p {...swap} />; ${READ}`,
    entries: undefined,
  },
  {
    id: 'template-substitution-as-call',
    source: `${STATED} void \`\${1}\`; ${READ}`,
    entries: undefined,
  },
  {
    id: 'template-without-substitution-pin',
    source: `${STATED} void \`fixed\`; ${READ}`,
    entries: ['{}', "'stack'"],
  },
  {
    id: 'unreachable-implicit-work-pin',
    source: `${STATED} const total = 1 + 2; void +total; for (const each of [total]) void each; const { length } = 'text'; void length; ${READ}`,
    entries: ['{}', "'stack'"],
  },
];

/** The `Reflect.get.apply` calls in `root`, by a walk of its tree. */
function readsOf(root: Node): readonly CallExpression[] {
  const calls: CallExpression[] = [];
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isCallExpression(node) && node.expression.getText() === 'Reflect.get.apply')
      calls.push(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return calls;
}

describe('implicit work before a tuple’s native read', () => {
  it.each(CASES)('$id', ({ source, entries }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'tuple-implicit-work.tsx', source);
    const read = readsOf(parsed.sourceFile).map((call) => {
      const list = call.arguments[1];
      return list === undefined
        ? undefined
        : framedAppliedArguments(call, list)?.map((each) => each.getText());
    });

    expect(read).toStrictEqual([entries]);
  });
});
