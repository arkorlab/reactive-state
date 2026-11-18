import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * A list a call spreads or applies is followed through its reassignments with the range of
 * positions still wanted. A list that prepends to itself (`sources = [item, ...sources]`) asks for
 * one position fewer each time round, and a range with no end (`Object.assign(target, ...sources)`
 * takes every source) is a range of `Number.MAX_SAFE_INTEGER` positions: each round was a state not
 * seen, so the walk ran about 9e15 rounds. Each row runs in a child process that is killed when it
 * does not finish.
 */
interface CycleCase {
  readonly id: string;
  readonly roots: readonly string[];
  readonly source: string;
}

const LIMITS = { childMilliseconds: 20_000, testMilliseconds: 40_000 } as const;
const PACKAGE = fileURLToPath(new URL('..', import.meta.url));

/** The path of a module of the compiler, as text the child can import. */
function compilerModule(name: string): string {
  return JSON.stringify(fileURLToPath(new URL(`../src/compiler/${name}`, import.meta.url)));
}

const PRELUDE = [
  "const sharedEvent = new Event('ping');",
  'declare const items: readonly object[];',
].join('\n');

const CASES: readonly CycleCase[] = [
  {
    id: 'module-prepend-then-object-assign-spread-beside-apply-list',
    roots: ['sharedEvent', 'args'],
    source: [
      'let sources: object[] = [{}];',
      'sources = [{ x: 1 }, ...sources];',
      'const target = {};',
      'Object.assign(target, ...sources);',
      'export function run(): void {',
      '  const emitter = new EventTarget();',
      '  const args = [sharedEvent];',
      '  emitter.dispatchEvent.apply(emitter, args);',
      '}',
    ].join('\n'),
  },
  {
    id: 'local-prepend-then-object-assign-spread-beside-apply-list',
    roots: ['sharedEvent', 'args'],
    source: [
      'export function run(): void {',
      '  const emitter = new EventTarget();',
      '  const target = {};',
      '  let sources: object[] = [{}];',
      '  sources = [{ x: 1 }, ...sources];',
      '  Object.assign(target, ...sources);',
      '  const args = [sharedEvent];',
      '  emitter.dispatchEvent.apply(emitter, args);',
      '}',
    ].join('\n'),
  },
  {
    id: 'loop-prepend-then-object-assign-spread-beside-apply-list',
    roots: ['sharedEvent', 'args'],
    source: [
      'export function run(): void {',
      '  const emitter = new EventTarget();',
      '  const target = {};',
      '  let sources: object[] = [];',
      '  for (const item of items) {',
      '    sources = [item, ...sources];',
      '  }',
      '  Object.assign(target, ...sources);',
      '  const args = [sharedEvent];',
      '  emitter.dispatchEvent.apply(emitter, args);',
      '}',
    ].join('\n'),
  },
  {
    id: 'prepended-sources-assigned-into-the-apply-list-keep-their-event',
    roots: ['sharedEvent', 'item', 'args'],
    source: [
      'export function run(): void {',
      '  const emitter = new EventTarget();',
      '  const args: Event[] = [];',
      '  let sources: object[] = [{ 0: sharedEvent }];',
      '  for (const item of items) {',
      '    sources = [item, ...sources];',
      '  }',
      '  Object.assign(args, ...sources);',
      '  emitter.dispatchEvent.apply(emitter, args);',
      '}',
    ].join('\n'),
  },
  {
    id: 'prepended-apply-list-of-object-assign-keeps-the-array-target',
    roots: ['sharedEvent', 'args'],
    source: [
      'export function run(): void {',
      '  const emitter = new EventTarget();',
      '  const args: Event[] = [];',
      '  let list: object[] = [args, { 0: sharedEvent }];',
      '  for (const item of items) {',
      '    list = [item, ...list];',
      '  }',
      '  Object.assign.apply(Object, list as [object, ...object[]]);',
      '  emitter.dispatchEvent.apply(emitter, args);',
      '}',
    ].join('\n'),
  },
  {
    id: 'two-lists-prepending-the-other-list-to-each-other',
    roots: ['sharedEvent', 'item', 'item', 'args'],
    source: [
      'export function run(): void {',
      '  const emitter = new EventTarget();',
      '  const args: Event[] = [];',
      '  let first: object[] = [{ 0: sharedEvent }];',
      '  let second: object[] = [{}];',
      '  for (const item of items) {',
      '    first = [item, ...second];',
      '    second = [item, ...first];',
      '  }',
      '  Object.assign(args, ...first);',
      '  emitter.dispatchEvent.apply(emitter, args);',
      '}',
    ].join('\n'),
  },
  {
    id: 'append-pin-ends-without-the-range-rule',
    roots: ['sharedEvent', 'args'],
    source: [
      'export function run(): void {',
      '  const emitter = new EventTarget();',
      '  const target = {};',
      '  let sources: object[] = [{}];',
      '  for (const item of items) {',
      '    sources = [...sources, item];',
      '  }',
      '  Object.assign(target, ...sources);',
      '  const args = [sharedEvent];',
      '  emitter.dispatchEvent.apply(emitter, args);',
      '}',
    ].join('\n'),
  },
];

/** What the child runs: the roots `writtenArgumentBy` names for the last call of `run`. */
function childScript(source: string): string {
  return [
    `const { openTypeScript, parseModule } = await import(${compilerModule('typescript.ts')});`,
    `const { rootOf } = await import(${compilerModule('kept.ts')});`,
    `const { writtenArgumentBy } = await import(${compilerModule('written.ts')});`,
    "const { isCallExpression } = await import('typescript/ast');",
    'const api = openTypeScript();',
    `using parsed = parseModule(api, 'cycle.ts', ${JSON.stringify(source)});`,
    'let found;',
    'const visit = (node) => {',
    '  if (isCallExpression(node)) {',
    '    found = node;',
    '  }',
    '  node.forEachChild(visit);',
    '};',
    "const run = parsed.sourceFile.statements.find((each) => each.name?.text === 'run');",
    'visit(run);',
    'const named = writtenArgumentBy(found).flatMap((each) => rootOf(each)?.text ?? []);',
    'console.log(JSON.stringify(named));',
  ].join('\n');
}

describe('lists a call spreads or applies, prepended to by themselves', () => {
  it.each(CASES)('$id', { timeout: LIMITS.testMilliseconds }, ({ roots, source }) => {
    const ran = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', childScript(`${PRELUDE}\n${source}`)],
      {
        cwd: PACKAGE,
        encoding: 'utf8',
        killSignal: 'SIGKILL',
        timeout: LIMITS.childMilliseconds,
      },
    );

    expect(ran.error?.message).toBeUndefined();
    expect(ran.stderr).toBe('');
    expect(JSON.parse(ran.stdout) as unknown).toStrictEqual(roots);
  });
});
