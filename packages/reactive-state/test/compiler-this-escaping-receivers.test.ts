import {
  type CallExpression,
  isCallExpression,
  isElementAccessExpression,
  isFunctionDeclaration,
  type Identifier,
  isIdentifier,
  isPropertyAccessExpression,
  type Node,
} from 'typescript/ast';
import { type API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { methodsOf, writesThis } from '../src/compiler/held-methods.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { methodOf, writtenBy } from '../src/compiler/written.ts';

/**
 * A default a method takes from `this` is read as the fresh value it writes while the receiver's
 * member stays missing or `undefined` and the default itself is not changed: a binding of the
 * module read as anything but the object of a member access (an argument, an element, a property
 * value, an alias), or whose members are assigned anywhere in the module, is not read so.
 */
const CASES = [
  {
    id: 'receiver-member-assigned-in-another-function',
    source:
      'const shared = { items: [] as number[] }; const counter = { missing: undefined as { items: number[] } | undefined, bump() { const { missing = { items: [] as number[] } } = this; missing.items.push(1); } }; export function setup() { counter.missing = shared; } export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'receiver-stored-in-an-array',
    source:
      'const shared = { items: [] as number[] }; const counter = { missing: undefined as { items: number[] } | undefined, bump() { const { missing = { items: [] as number[] } } = this; missing.items.push(1); } }; const all = [counter]; export function setup() { all[0]!.missing = shared; } export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'receiver-stored-in-an-object-literal',
    source:
      'const shared = { items: [] as number[] }; const counter = { missing: undefined as { items: number[] } | undefined, bump() { const { missing = { items: [] as number[] } } = this; missing.items.push(1); } }; const holder = { counter }; export function setup() { holder.counter.missing = shared; } export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'receiver-aliased-by-a-constant',
    source:
      'const shared = { items: [] as number[] }; const counter = { missing: undefined as { items: number[] } | undefined, bump() { const { missing = { items: [] as number[] } } = this; missing.items.push(1); } }; const alias = counter; export function setup() { alias.missing = shared; } export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'receiver-member-assigned-through-a-parameter-known-limit-pin',
    source:
      'const shared = { items: [] as number[] }; const counter = { missing: undefined as { items: number[] } | undefined, bump() { const { missing = { items: [] as number[] } } = this; missing.items.push(1); } }; export function setup(other: typeof counter) { other.missing = shared; } export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'receiver-nested-member-assigned-in-another-function',
    source:
      'const shared = { items: [] as number[] }; const counter = { cfg: { missing: undefined as { items: number[] } | undefined }, bump() { const { cfg: { missing = { items: [] as number[] } } } = this; missing.items.push(1); } }; export function setup() { counter.cfg.missing = shared; } export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'receiver-member-assigned-by-a-pattern',
    source:
      'const shared = { items: [] as number[] }; const counter = { missing: undefined as { items: number[] } | undefined, bump() { const { missing = { items: [] as number[] } } = this; missing.items.push(1); } }; export function setup() { [counter.missing] = [shared]; } export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'receiver-passed-as-an-argument-pin',
    source:
      'const shared = { items: [] as number[] }; const counter = { missing: undefined as { items: number[] } | undefined, bump() { const { missing = { items: [] as number[] } } = this; missing.items.push(1); } }; export function setup() { Object.assign(counter, { missing: shared }); } export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'default-member-reassigned-from-the-receiver-then-mutated',
    source:
      'const counter = { missing: undefined as { items: number[] } | undefined, live: [1], bump() { const { missing = { items: [] as number[] } } = this; missing.items = this.live; missing.items.push(2); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'default-handed-to-a-function-then-mutated',
    source:
      'function keep(value: unknown) { return value; } const counter = { missing: undefined as { items: number[] } | undefined, bump() { const { missing = { items: [] as number[] } } = this; keep(missing); missing.items.push(2); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'default-member-assigned-by-a-pattern-then-mutated',
    source:
      'const counter = { missing: undefined as { items: number[] } | undefined, live: [1], bump() { const { missing = { items: [] as number[] } } = this; [missing.items] = [this.live]; missing.items.push(2); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'receiver-only-called-and-read-stays-false-pin',
    source:
      'const counter = { missing: undefined as { items: number[] } | undefined, log: [] as number[], bump() { const { missing = { items: [] as number[] } } = this; missing.items.push(1); } }; export function peek() { return [counter.missing, counter.log.length]; } export function fill() { counter.log.push(1); } export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'fresh-default-mutated-in-place-stays-false-pin',
    source:
      'const counter = { missing: undefined as { items: number[] } | undefined, bump() { const { missing = { items: [] as number[] } } = this; missing.items.push(1); return missing.items.length; } }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'fresh-default-array-mutated-in-place-stays-false-pin',
    source:
      'const counter = { items: undefined as number[] | undefined, bump() { const { items = [] as number[] } = this; items.push(1); } }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'receiver-primitive-members-assigned-elsewhere-stays-false-pin',
    source:
      "const counter = { missing: undefined as { items: number[] } | undefined, count: 0, label: 'a', note: 'b' as string | undefined, bump() { const { missing = { items: [] as number[] } } = this; missing.items.push(1); } }; export function reset() { counter.count = 0; counter.count++; counter.label += 'x'; counter.label = 'y'; delete counter.note; } export function run() { counter.bump(); }",
    writes: false,
  },
  {
    id: 'default-primitive-slot-assigned-stays-false-pin',
    source:
      'const counter = { missing: undefined as { n: number } | undefined, bump() { const { missing = { n: 0 } } = this; missing.n = 5; missing.n++; } }; export function run() { counter.bump(); }',
    writes: false,
  },
  {
    id: 'default-destructured-alias-slot-reassigned-from-the-receiver',
    source:
      'const counter = { missing: undefined as { items: number[] } | undefined, live: [1], bump() { const { missing = { outer: { items: [] as number[] } } } = this; const { outer } = missing as { outer: { items: number[] } }; outer.items = this.live; outer.items.push(1); } }; export function run() { counter.bump(); }',
    writes: true,
  },
  {
    id: 'default-destructured-alias-mutated-in-place-stays-false-pin',
    source:
      'const counter = { missing: undefined as { outer: { items: number[] } } | undefined, bump() { const { missing = { outer: { items: [] as number[] } } } = this; const { outer } = missing; outer.items.push(1); } }; export function run() { counter.bump(); }',
    writes: false,
  },
] as const;

/** The method call inside `run` in `root`. */
function runCall(root: Node): CallExpression {
  const statements: Node[] = [];
  root.forEachChild((node) => {
    if (isFunctionDeclaration(node) && node.name?.text === 'run' && node.body !== undefined) {
      statements.push(...node.body.statements);
    }
  });
  for (const statement of statements) {
    let found: CallExpression | undefined;
    const visit = (node: Node): void => {
      if (found !== undefined) {
        return;
      }
      if (isCallExpression(node) && methodOf(node) !== undefined) {
        found = node;
        return;
      }
      node.forEachChild(visit);
    };
    visit(statement);
    if (found !== undefined) {
      return found;
    }
  }
  throw new Error('Expected a method call in run().');
}

function receiverCallTarget(call: CallExpression): {
  readonly method: string;
  readonly receiver: Identifier;
} {
  const method = methodOf(call);
  const callee = unwrapped(call.expression);
  const receiver =
    isPropertyAccessExpression(callee) || isElementAccessExpression(callee)
      ? unwrapped(callee.expression)
      : undefined;
  if (method === undefined || receiver === undefined || !isIdentifier(receiver)) {
    throw new Error('Expected a receiver identifier call.');
  }
  return { method, receiver };
}

describe('receivers read as unchanged data while nothing hands them on or assigns into them', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(CASES)('$id', ({ source, writes }) => {
    using parsed = parseModule(api, 'this-escaping-receivers.ts', source);
    const call = runCall(parsed.sourceFile);
    const { method, receiver } = receiverCallTarget(call);

    expect(writesThis(methodsOf(receiver), method, writtenBy, { seen: new Set(), call })).toBe(
      writes,
    );
  });
});
