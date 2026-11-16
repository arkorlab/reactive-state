import {
  type CallExpression,
  type Expression,
  isCallExpression,
  isClassDeclaration,
  isExpressionStatement,
  isFunctionDeclaration,
  isIdentifier,
  type Node,
  type SourceFile,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { argumentChanges } from '../src/compiler/argument-effects.ts';
import { unwrapped } from '../src/compiler/bounded.ts';
import { declarationOf, initializerOf } from '../src/compiler/framed.ts';
import { rootOf } from '../src/compiler/kept.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { writtenArgumentBy } from '../src/compiler/written.ts';

interface TransferSpreadCase {
  readonly argumentRoots: readonly string[];
  readonly body: string;
  readonly changed: boolean;
  readonly id: string;
}

/** Held, conditional and mutated spread arguments retain transfer write targets without breaking clean tuples. */
const TRANSFER_SPREAD_CASES: readonly TransferSpreadCase[] = [
  {
    id: 'void-read-const-tuple-spread-transfer',
    body: 'const args = [{ ok: true }, { transfer: [sharedBuffer] }] as const; void args; structuredClone(...args);',
    argumentRoots: ['sharedBuffer', 'args'],
    changed: true,
  },
  {
    id: 'length-read-const-tuple-spread-transfer',
    body: 'const args = [{ ok: true }, { transfer: [sharedBuffer] }] as const; const size = args.length; void size; structuredClone(...args);',
    argumentRoots: ['sharedBuffer', 'args'],
    changed: true,
  },
  {
    id: 'second-slot-void-read-options-spread-transfer',
    body: 'const opts = [{ transfer: [sharedBuffer] }] as const; void opts; structuredClone({ ok: true }, ...opts);',
    argumentRoots: ['sharedBuffer', 'opts'],
    changed: true,
  },
  {
    id: 'two-hop-const-alias-tuple-spread-transfer',
    body: 'const base = [{ ok: true }, { transfer: [sharedBuffer] }] as const; const args = base; structuredClone(...args);',
    argumentRoots: ['sharedBuffer', 'base'],
    changed: true,
  },
  {
    id: 'apply-const-tuple-transfer',
    body: 'const args = [{ ok: true }, { transfer: [sharedBuffer] }] as const; structuredClone.apply(undefined, args);',
    argumentRoots: ['sharedBuffer', 'args'],
    changed: true,
  },
  {
    id: 'inline-conditional-spread-transfer',
    body: 'structuredClone(...(flag ? [{ ok: true }, { transfer: [sharedBuffer] }] : [{ ok: false }]));',
    argumentRoots: ['sharedBuffer'],
    changed: true,
  },
  {
    id: 'const-conditional-spread-transfer',
    body: 'const args = flag ? [{ ok: true }, { transfer: [sharedBuffer] }] : [{ ok: false }]; structuredClone(...args);',
    argumentRoots: ['sharedBuffer'],
    changed: true,
  },
  {
    id: 'pushed-local-array-spread-transfer',
    body: 'const args: unknown[] = [{ ok: true }]; args.push({ transfer: [sharedBuffer] }); structuredClone(...args);',
    argumentRoots: ['args'],
    changed: true,
  },
  {
    id: 'unresolved-prefix-spread-before-transfer-options',
    body: 'structuredClone(...unknownPrefix, { transfer: [sharedBuffer] });',
    argumentRoots: ['sharedBuffer', 'unknownPrefix'],
    changed: true,
  },
  {
    id: 'reassigned-let-options-transfer',
    body: 'let options: StructuredSerializeOptions = {}; options = { transfer: [sharedBuffer] }; structuredClone({ ok: true }, options);',
    argumentRoots: ['options'],
    changed: true,
  },
  {
    id: 'post-message-void-read-tuple-spread-transfer-pin',
    body: 'const args = [{ ok: true }, [sharedBuffer]] as const; void args; port.postMessage(...args);',
    argumentRoots: [],
    changed: true,
  },
  {
    id: 'post-message-conditional-spread-transfer-pin',
    body: 'port.postMessage(...(flag ? [{ ok: true }, [sharedBuffer]] : [{ ok: false }]));',
    argumentRoots: [],
    changed: true,
  },
  {
    id: 'clean-const-tuple-spread-no-transfer-pin',
    body: 'const args = [sharedPayload, { transfer: [] }] as const; structuredClone(...args);',
    argumentRoots: [],
    changed: false,
  },
  {
    id: 'clean-conditional-tuple-spread-no-transfer-pin',
    body: 'structuredClone(...(flag ? [sharedPayload] : [sharedPayload, {}]));',
    argumentRoots: [],
    changed: false,
  },
  {
    id: 'trailing-unknown-spread-after-empty-options-pin',
    body: 'structuredClone(sharedPayload, {}, ...unknownPrefix);',
    argumentRoots: [],
    changed: false,
  },
];

/** Constant and declaration resolution matching the caller's static callee lookup. */
function calleeOf(node: Expression): Node | undefined {
  let value = unwrapped(node);
  const seen = new Set<Expression>();
  while (isIdentifier(value) && !seen.has(value)) {
    seen.add(value);
    const declared = declarationOf(value);
    if (
      declared !== undefined &&
      (isFunctionDeclaration(declared) || isClassDeclaration(declared))
    ) {
      return declared;
    }
    const initial = initializerOf(value);
    if (initial === undefined) {
      return value;
    }
    value = unwrapped(initial);
  }
  return value;
}

/** The argument passed to the trailing `take(...)` call in `file`. */
function testedArgument(file: SourceFile): Expression | undefined {
  const last = file.statements.at(-1);
  const call = last !== undefined && isExpressionStatement(last) ? last.expression : undefined;
  return call !== undefined && isCallExpression(call) ? call.arguments[0] : undefined;
}

/** The final call expression inside the named function declaration in `file`. */
function lastCallIn(file: SourceFile, fnName: string): CallExpression | undefined {
  const fn = file.statements.find(
    (statement) => isFunctionDeclaration(statement) && statement.name?.text === fnName,
  );
  if (fn === undefined) {
    return undefined;
  }
  let found: CallExpression | undefined;
  const visit = (node: Node): void => {
    if (isCallExpression(node)) {
      found = node;
    }
    node.forEachChild(visit);
  };
  visit(fn);
  return found;
}

/** Root binding names reported for `nodes`. */
function rootNames(nodes: readonly (Node | undefined)[]): readonly string[] {
  const names: string[] = [];
  for (const node of nodes) {
    const root = node === undefined ? undefined : rootOf(node);
    if (root !== undefined) {
      names.push(root.text);
    }
  }
  return names;
}

describe('transfer write targets across unexpanded, conditional and mutated spreads', () => {
  it.each(TRANSFER_SPREAD_CASES)('$id', ({ argumentRoots, body, changed }) => {
    const source = [
      'const sharedBuffer = new ArrayBuffer(8);',
      'const sharedPayload = { ok: true };',
      'function take(value: unknown): unknown { return value; }',
      'function run(flag: boolean, unknownPrefix: unknown[], port: { postMessage: (...given: unknown[]) => void }) {',
      `  ${body}`,
      '  return 0;',
      '}',
      'declare const cond: boolean;',
      'declare const prefix: unknown[];',
      'declare const channelPort: { postMessage: (...given: unknown[]) => void };',
      'take(run(cond, prefix, channelPort));',
    ].join('\n');
    using api = openTypeScript();
    using parsed = parseModule(api, 'written-transfer-spreads.ts', source);
    const call = lastCallIn(parsed.sourceFile, 'run');
    const argument = testedArgument(parsed.sourceFile);

    expect(call === undefined ? undefined : rootNames(writtenArgumentBy(call))).toStrictEqual(
      argumentRoots,
    );
    expect(argument === undefined ? undefined : argumentChanges(argument, calleeOf)).toBe(changed);
  });
});
