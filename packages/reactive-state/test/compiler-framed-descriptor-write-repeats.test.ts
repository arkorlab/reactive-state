import {
  type CallExpression,
  isCallExpression,
  isIdentifier,
  isPropertyAccessExpression,
  type Expression,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedDescriptorWrites } from '../src/compiler/framed-descriptor-writes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A write to a native descriptor's `value` after the read in the same owner still reaches the
 * read where that owner runs again with the descriptor as the last run left it: a loop around both,
 * or a function called again, when the descriptor is made outside the repeated part. A descriptor
 * made inside it is made anew each time, a loop that leaves after the write does not come round,
 * and a module's top level runs once.
 */
const DESCRIBED = "const d = Object.getOwnPropertyDescriptor(source, 'x')!;";
const CASES = [
  {
    id: 'for-of-loop',
    source: `${DESCRIBED} for (const e of errors) { use(d.value); d.value = e; }`,
    values: ['e'],
  },
  {
    id: 'while-loop',
    source: `${DESCRIBED} while (more()) { use(d.value); d.value = new Error('next'); }`,
    values: ["new Error('next')"],
  },
  {
    id: 'function-called-again',
    source: `${DESCRIBED} function run(e: Error) { use(d.value); d.value = e; }`,
    values: ['e'],
  },
  {
    id: 'arrow-called-again',
    source: `${DESCRIBED} const run = (e: Error) => { use(d.value); d.value = e; };`,
    values: ['e'],
  },
  {
    id: 'object-assign-in-function',
    source: `${DESCRIBED} function run(e: Error) { use(d.value); Object.assign(d, { value: e }); }`,
    values: ['e'],
  },
  {
    id: 'read-through-alias',
    source: `${DESCRIBED} const copy = d; function run(e: Error) { use(copy.value); copy.value = e; }`,
    values: ['e'],
  },
  {
    id: 'loop-in-function-called-again',
    source: `${DESCRIBED} function run(e: Error) { for (let i = 0; i < 1; i++) { use(d.value); d.value = e; break; } }`,
    values: ['e'],
  },
  {
    id: 'once-at-top-level-pin',
    source: `${DESCRIBED} use(d.value); d.value = new Error('late');`,
    values: [],
  },
  {
    id: 'made-in-the-function-pin',
    source: `function run(e: Error) { ${DESCRIBED} use(d.value); d.value = e; }`,
    values: [],
  },
  {
    id: 'made-in-the-loop-pin',
    source: `for (const e of errors) { ${DESCRIBED} use(d.value); d.value = e; }`,
    values: [],
  },
  {
    id: 'loop-that-leaves-pin',
    source: `${DESCRIBED} for (const e of errors) { use(d.value); d.value = e; break; }`,
    values: [],
  },
  {
    id: 'write-before-read-pin',
    source: `${DESCRIBED} d.value = new Error('early'); use(d.value);`,
    values: ["new Error('early')"],
  },
  {
    id: 'write-in-other-function-pin',
    source: `${DESCRIBED} function later(e: Error) { d.value = e; } use(d.value);`,
    values: ['e'],
  },
] as const;

describe('writes to a descriptor value after its read', () => {
  it.each(CASES)('$id', ({ source, values }) => {
    using api = openTypeScript();
    using parsed = parseModule(
      api,
      'descriptor-write-repeats.ts',
      `declare const source: object; declare const errors: Error[]; declare function more(): boolean; declare function use(value: unknown): void;\n${source}`,
    );
    const read = descriptorRead(parsed.sourceFile);

    expect(framedDescriptorWrites(read).map((each) => each.getText())).toStrictEqual(values);
  });
});

/** The descriptor name in the first `use(name.value)` that reads it. */
function descriptorRead(root: Node): Expression {
  const pending: Node[] = [root];
  let found: Expression | undefined;
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    const read = isCallExpression(node) ? usedDescriptor(node) : undefined;
    if (read !== undefined && (found === undefined || read.pos < found.pos)) found = read;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  if (found === undefined) throw new Error('no use(descriptor.value) call');
  return found;
}

function usedDescriptor(call: CallExpression): Expression | undefined {
  const [argument] = call.arguments;
  if (argument === undefined || !isPropertyAccessExpression(argument)) return undefined;
  return isIdentifier(call.expression) && call.expression.text === 'use'
    ? argument.expression
    : undefined;
}
