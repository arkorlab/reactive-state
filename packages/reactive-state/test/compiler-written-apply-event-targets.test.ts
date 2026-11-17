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
import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { argumentChanges } from '../src/compiler/argument-effects.ts';
import { unwrapped } from '../src/compiler/bounded.ts';
import { declarationOf, initializerOf } from '../src/compiler/framed.ts';
import { isKept, rootOf, runsPerCall, targetsOf } from '../src/compiler/kept.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { writtenArgumentBy, writtenBy } from '../src/compiler/written.ts';

interface KeptApplyCase {
  readonly argumentRoots: readonly string[];
  readonly body: string;
  readonly id: string;
  readonly keptRoot: string | undefined;
}

/** Retained `Event` and `Reflect.set` receiver targets behind local `apply` and spread containers. */
const KEPT_APPLY_CASES: readonly KeptApplyCase[] = [
  {
    argumentRoots: ['sharedEvent', 'args'],
    body: 'const emitter = new EventTarget(); const args = [sharedEvent]; new EventTarget().dispatchEvent.apply(emitter, args);',
    id: 'local-const-array-instance-dispatch-event-apply',
    keptRoot: 'sharedEvent',
  },
  {
    argumentRoots: ['sharedEvent', 'args'],
    body: 'const emitter = new EventTarget(); const args = [sharedEvent]; EventTarget.prototype.dispatchEvent.apply(emitter, args);',
    id: 'local-const-array-prototype-dispatch-event-apply',
    keptRoot: 'sharedEvent',
  },
  {
    argumentRoots: ['sharedEvent', 'args'],
    body: 'const emitter = new EventTarget(); const args = [sharedEvent]; Reflect.apply(EventTarget.prototype.dispatchEvent, emitter, args);',
    id: 'local-const-array-reflect-apply-dispatch-event',
    keptRoot: 'sharedEvent',
  },
  {
    argumentRoots: ['sharedEvent', 'args'],
    body: 'const emitter = new EventTarget(); const dispatch = EventTarget.prototype.dispatchEvent.bind(emitter); const args = [sharedEvent]; dispatch.apply(undefined, args);',
    id: 'bound-dispatch-event-called-via-apply-local-array',
    keptRoot: 'sharedEvent',
  },
  {
    argumentRoots: ['sharedEvent', 'args'],
    body: "const emitter = new EventTarget(); const fn = emitter.dispatchEvent; const args = [sharedEvent]; fn['apply'](emitter, args);",
    id: 'aliased-method-bracketed-apply-local-array',
    keptRoot: 'sharedEvent',
  },
  {
    argumentRoots: ['sharedEvent', 'args'],
    body: 'const emitter = new EventTarget(); const args = [sharedEvent] as const; void args; emitter.dispatchEvent(...args);',
    id: 'void-read-const-tuple-spread-dispatch-event',
    keptRoot: 'sharedEvent',
  },
  {
    argumentRoots: ['sharedEvent', 'args'],
    body: 'const emitter = new EventTarget(); const base = [sharedEvent]; const args = base; emitter.dispatchEvent.apply(emitter, args);',
    id: 'two-hop-const-alias-local-apply-dispatch-event',
    keptRoot: 'sharedEvent',
  },
  {
    argumentRoots: ['sharedEvent', 'args'],
    body: 'const emitter = new EventTarget(); const head = [sharedEvent]; const args = [...head]; emitter.dispatchEvent.apply(emitter, args);',
    id: 'nested-spread-inside-local-apply-dispatch-event',
    keptRoot: 'sharedEvent',
  },
  {
    argumentRoots: ['sharedEvent', 'args'],
    body: "const emitter = new EventTarget(); const args = flag ? [sharedEvent] : [new Event('local')]; emitter.dispatchEvent.apply(emitter, args);",
    id: 'conditional-local-apply-list-dispatch-event',
    keptRoot: 'sharedEvent',
  },
  {
    argumentRoots: ['sharedEvent'],
    body: "const emitter = new EventTarget(); emitter.dispatchEvent(flag ? sharedEvent : new Event('local'));",
    id: 'conditional-positional-argument-dispatch-event',
    keptRoot: 'sharedEvent',
  },
  {
    argumentRoots: ['sharedEvent', 'args'],
    body: 'const emitter = new EventTarget(); let args: Event[] = []; args = [sharedEvent]; emitter.dispatchEvent.apply(emitter, args);',
    id: 'reassigned-let-array-apply-dispatch-event',
    keptRoot: 'sharedEvent',
  },
  {
    argumentRoots: ['sharedEvent', 'args'],
    body: 'const emitter = new EventTarget(); const args: Event[] = []; args.push(sharedEvent); emitter.dispatchEvent.apply(emitter, args);',
    id: 'pushed-local-array-apply-dispatch-event',
    keptRoot: 'sharedEvent',
  },
  {
    argumentRoots: ['sharedEvent', 'args'],
    body: "const emitter = new EventTarget(); const args = [new Event('local'), sharedEvent]; args.shift(); emitter.dispatchEvent.apply(emitter, args);",
    id: 'shifted-local-array-apply-dispatch-event',
    keptRoot: 'sharedEvent',
  },
  {
    argumentRoots: ['sharedTarget', 'args'],
    body: "const args = [{}, 'next', 1, sharedTarget]; Reflect.set.apply(Reflect, args);",
    id: 'local-const-array-reflect-set-apply-fourth-receiver',
    keptRoot: 'sharedTarget',
  },
  {
    argumentRoots: ['sharedTarget', 'args'],
    body: "const setSlot = Reflect.set.bind(Reflect); const args: unknown[] = [{}, 'next', 1]; args.push(sharedTarget); setSlot.apply(undefined, args);",
    id: 'bound-reflect-set-apply-pushed-fourth-receiver',
    keptRoot: 'sharedTarget',
  },
  {
    argumentRoots: ['localEvent', 'args'],
    body: "const emitter = new EventTarget(); const localEvent = new Event('local'); const args = [localEvent]; emitter.dispatchEvent.apply(emitter, args);",
    id: 'local-event-behind-local-apply-not-kept-pin',
    keptRoot: undefined,
  },
  {
    argumentRoots: ['args'],
    body: "const emitter = new EventTarget(); const args = [new Event('local'), sharedEvent]; emitter.dispatchEvent.apply(emitter, args);",
    id: 'unused-second-slot-shared-event-not-kept-pin',
    keptRoot: undefined,
  },
  {
    argumentRoots: ['args'],
    body: "const localObj: Record<string, unknown> = {}; const args = [localObj, 'value', sharedTarget]; Reflect.set.apply(Reflect, args);",
    id: 'three-element-reflect-set-apply-value-slot-not-receiver-pin',
    keptRoot: undefined,
  },
  {
    argumentRoots: ['sharedArgs'],
    body: 'const emitter = new EventTarget(); emitter.dispatchEvent.apply(emitter, sharedArgs);',
    id: 'kept-opaque-apply-array-preserved-pin',
    keptRoot: 'sharedArgs',
  },
  {
    argumentRoots: [],
    body: 'const emitter = new EventTarget(); const empty = undefined; emitter.dispatchEvent.apply(emitter, empty);',
    id: 'const-undefined-apply-list-dispatch-event-pin',
    keptRoot: undefined,
  },
  {
    argumentRoots: ['sharedEvent', 'args'],
    body: 'const emitter = new EventTarget(); const args: Event[] = []; Array.prototype.push.call(args, sharedEvent); emitter.dispatchEvent.apply(emitter, args);',
    id: 'borrowed-array-push-call-local-apply-dispatch-event',
    keptRoot: 'sharedEvent',
  },
  {
    argumentRoots: ['sharedEvent', 'args'],
    body: 'const emitter = new EventTarget(); const args: Event[] = []; Reflect.apply(Array.prototype.push, args, [sharedEvent]); emitter.dispatchEvent.apply(emitter, args);',
    id: 'reflect-apply-array-push-local-apply-dispatch-event',
    keptRoot: 'sharedEvent',
  },
  {
    argumentRoots: ['sharedEvent', 'args'],
    body: 'const emitter = new EventTarget(); const args: Event[] = []; const append = args.push.bind(args); append(sharedEvent); emitter.dispatchEvent.apply(emitter, args);',
    id: 'bound-array-push-local-apply-dispatch-event',
    keptRoot: 'sharedEvent',
  },
  {
    argumentRoots: ['sharedEvent', 'args'],
    body: 'const emitter = new EventTarget(); { var args = [sharedEvent]; } emitter.dispatchEvent.apply(emitter, args);',
    id: 'hoisted-var-array-in-nested-block-apply-dispatch-event',
    keptRoot: 'sharedEvent',
  },
  {
    argumentRoots: ['sharedEvent', 'args'],
    body: 'const emitter = new EventTarget(); { var { list: args } = { list: [sharedEvent] }; } emitter.dispatchEvent.apply(emitter, args);',
    id: 'hoisted-destructured-var-array-apply-dispatch-event',
    keptRoot: 'sharedEvent',
  },
  {
    argumentRoots: ['branchedSharedEvent'],
    body: 'const emitter = new EventTarget(); emitter.dispatchEvent(branchedSharedEvent);',
    id: 'module-conditional-const-event-retained-identity',
    keptRoot: 'branchedSharedEvent',
  },
  {
    argumentRoots: ['branchedSharedTarget'],
    body: "Reflect.set({}, 'next', 1, branchedSharedTarget);",
    id: 'module-conditional-const-reflect-set-fourth-receiver-identity',
    keptRoot: 'branchedSharedTarget',
  },
  {
    argumentRoots: ['args'],
    body: "const emitter = new EventTarget(); const args: Event[] = []; args.push(new Event('local'), sharedEvent); emitter.dispatchEvent.apply(emitter, args);",
    id: 'pushed-second-slot-shared-event-not-kept-pin',
    keptRoot: undefined,
  },
  {
    argumentRoots: ['args'],
    body: "const emitter = new EventTarget(); const args: Event[] = []; args.push(new Event('local')); args.push(sharedEvent); emitter.dispatchEvent.apply(emitter, args);",
    id: 'sequential-second-push-shared-event-not-kept-pin',
    keptRoot: undefined,
  },
  {
    argumentRoots: ['sharedEvent', 'args'],
    body: "const emitter = new EventTarget(); const args: Event[] = []; if (flag) { args.push(new Event('local')); } args.push(sharedEvent); emitter.dispatchEvent.apply(emitter, args);",
    id: 'conditional-first-push-then-shared-event-still-reaches-first-slot',
    keptRoot: 'sharedEvent',
  },
];

const ARGUMENT_EFFECT_CASES = [
  {
    body: "const args = [{}, 'x', 1, sharedTarget]; Reflect.set.apply(Reflect, args);",
    changed: true,
    id: 'argument-effect-reflect-set-apply-shared-fourth-receiver',
  },
  {
    body: 'const emitter = new EventTarget(); const args = [sharedEvent]; emitter.dispatchEvent.apply(emitter, args);',
    changed: true,
    id: 'argument-effect-dispatch-event-apply-shared-event',
  },
  {
    body: 'const values: number[] = []; values.push(1); return values.length;',
    changed: false,
    id: 'argument-effect-fresh-local-array-unchanged-pin',
  },
] as const;

describe('retained event and Reflect.set receiver targets behind local apply and spread lists', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  it.each(KEPT_APPLY_CASES)('$id', ({ argumentRoots, body, keptRoot }) => {
    const source = [
      'declare const enabled: boolean;',
      "const sharedEvent = new Event('ping');",
      "const branchedSharedEvent = enabled ? new Event('a') : new Event('b');",
      'const sharedTarget: Record<string, unknown> = {};',
      'const branchedSharedTarget = enabled ? { a: 1 } : { b: 2 };',
      'declare const sharedArgs: Event[];',
      `export function run(flag: boolean): void { void flag; ${body} }`,
    ].join('\n');
    using parsed = parseModule(api, 'written-apply-event-targets.ts', source);
    const call = lastCallIn(parsed.sourceFile, 'run');

    expect(call === undefined ? undefined : rootNames(writtenArgumentBy(call))).toStrictEqual(
      argumentRoots,
    );
    expect(call === undefined ? undefined : keptWrittenRoot(call)).toBe(keptRoot);
  });

  it.each(ARGUMENT_EFFECT_CASES)('$id', ({ body, changed }) => {
    const source = [
      "const sharedEvent = new Event('ping');",
      'const sharedTarget: Record<string, unknown> = {};',
      `function helper() { ${body} }`,
      'function take(_value: unknown): void {}',
      'take(helper());',
    ].join('\n');
    using parsed = parseModule(api, 'written-apply-argument-effects.ts', source);
    const argument = testedArgument(parsed.sourceFile);

    expect(argument === undefined ? undefined : argumentChanges(argument, calleeOf)).toBe(changed);
  });
});

/** Mirrors `settled.ts`'s `keptWrite` check across `writtenBy` and `writtenArgumentBy`. */
function keptWrittenRoot(node: CallExpression): string | undefined {
  const written = writtenBy(node);
  const argument = writtenArgumentBy(node);
  if ((written === undefined && argument.length === 0) || !runsPerCall(node)) {
    return undefined;
  }
  for (const changed of [written, ...argument]) {
    if (changed === undefined) {
      continue;
    }
    for (const target of targetsOf(changed)) {
      const root = rootOf(target);
      if (root !== undefined && isKept(root, writtenBy)) {
        return root.text;
      }
    }
  }
  return undefined;
}

/** Root binding names reported for `nodes`. */
function rootNames(nodes: readonly Node[]): readonly string[] {
  const names: string[] = [];
  for (const node of nodes) {
    const root = rootOf(node);
    if (root !== undefined) {
      names.push(root.text);
    }
  }
  return names;
}

/** Finds the final call expression inside the named function declaration in `file`. */
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
