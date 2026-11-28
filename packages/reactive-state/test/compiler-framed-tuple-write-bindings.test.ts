import { type Identifier, isIdentifier, type Node } from 'typescript/ast';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { argumentArrayExposed } from '../src/compiler/framed-array-selections.ts';
import { type FrameBinding, frameBindingOf } from '../src/compiler/framed-bindings.ts';
import { framedRead } from '../src/compiler/framed.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

// The module keeps its own answers; its calls are counted by the rows that read the file.
vi.mock(import('../src/compiler/framed-bindings.ts'), { spy: true });

/**
 * A function that writes one entry of a tuple many times (`args[0] = error;` …) and then reads
 * the tuple (`Reflect.get(...args)`) asks, at each write, whether the tuple's other uses may run
 * before it. Each such question took the uses of the tuple one by one, from the last, and resolved
 * every name again to find which variable it reads — so the writes after the one asked about were
 * each looked up for each write before them, and a compile took seconds at a few thousand writes.
 * The rows pin what is answered of each place a tuple is read, then count the lookups: one for
 * each name of the file, however many writes ask.
 */

const TUPLE = 'const args: [object] = [{}];';

/** A function of `error`, `cond` and `items`, with a tuple `args` declared first. */
function frame(body: string): string {
  return `function frames(error: Error, cond: boolean, items: object[]) { ${TUPLE} ${body} }`;
}

type Reach = boolean | 'loops';

/** Every identifier of a source, in the order they are written. */
function identifiersOf(root: Node): readonly Identifier[] {
  const found: Identifier[] = [];
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isIdentifier(node)) found.push(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return found.toSorted((left, right) => left.pos - right.pos);
}

/** The variable or parameter a name reads. */
function bindingOf(name: Identifier | undefined, what: string): FrameBinding {
  const binding = name === undefined ? undefined : frameBindingOf(name)?.binding;
  if (binding === undefined) throw new Error(`No binding of ${what}.`);
  return binding;
}

interface Asked {
  readonly also?: string | undefined;
  readonly reached: Reach;
  readonly unchanged?: (name: Identifier, read: Identifier) => boolean;
}

/** Whether the uses of the tuple `args` expose it where a `read` comment follows it, and `also` with it. */
function exposed(source: string, asked: Asked): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'tuple-write-bindings.ts', source);
  const names = identifiersOf(parsed.sourceFile);
  const read = names.find(
    (name) => name.text === 'args' && source.startsWith('/*read*/', name.end),
  );
  if (read === undefined) throw new Error(`No read marked in ${source}.`);
  const aliases = new Set([bindingOf(read, 'args')]);
  if (asked.also !== undefined) {
    aliases.add(
      bindingOf(
        names.find((name) => name.text === asked.also),
        asked.also,
      ),
    );
  }
  const { unchanged } = asked;
  return argumentArrayExposed(
    read,
    aliases,
    unchanged === undefined ? undefined : (name) => unchanged(name, read),
    asked.reached,
  );
}

interface Case {
  readonly id: string;
  readonly source: string;
  readonly also?: string | undefined;
  readonly answers: {
    /** Where a loop's condition or update, and what a pattern around the read destructures, count. */
    readonly byDefault: boolean;
    readonly whenReached: boolean;
    /** Where only a loop's body repeats. */
    readonly bodiesOnly: boolean;
  };
}

/**
 * What the uses of a tuple expose at one read of it, by what runs before the read: a use written
 * before it, in a closure, in a loop's later pass, or in what a pattern around it destructures —
 * and what does not: one written after it, in a branch no run takes, or in a function nothing calls.
 * These answers were the same before the lookups were made once, and are pinned as they were.
 */
const CASES: readonly Case[] = [
  {
    id: 'write-after-read',
    source: frame('args/*read*/; args[0] = {};'),
    answers: { byDefault: false, whenReached: false, bodiesOnly: false },
  },
  {
    id: 'write-before-read',
    source: frame('args[0] = {}; args/*read*/;'),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'many-writes-before',
    source: frame(`${'args[0] = error; '.repeat(30)}args/*read*/;`),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'many-writes-after',
    source: frame(`args/*read*/; ${'args[0] = error; '.repeat(30)}`),
    answers: { byDefault: false, whenReached: false, bodiesOnly: false },
  },
  {
    id: 'writes-both-sides',
    source: frame(
      `${'args[0] = error; '.repeat(10)}args/*read*/; ${'args[0] = error; '.repeat(10)}`,
    ),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'while-loop-write-after',
    source: frame('while (cond) { args/*read*/; args[0] = {}; }'),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'while-loop-write-before',
    source: frame('while (cond) { args[0] = {}; args/*read*/; }'),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'while-loop-write-outside-after',
    source: frame('while (cond) { args/*read*/; } args[0] = {};'),
    answers: { byDefault: false, whenReached: false, bodiesOnly: false },
  },
  {
    id: 'for-initializer-read',
    source: frame('for (let at = args/*read*/.length; at < 2; at++) { args[0] = {}; }'),
    answers: { byDefault: false, whenReached: false, bodiesOnly: false },
  },
  {
    id: 'for-condition-read-body-write',
    source: frame('for (let at = 0; at < args/*read*/.length; at++) { args[0] = {}; }'),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'for-of-iterable-read',
    source: frame('for (const each of args/*read*/) { args[0] = each; }'),
    answers: { byDefault: false, whenReached: false, bodiesOnly: false },
  },
  {
    id: 'for-of-body-write-after-read',
    source: frame('for (const each of items) { args/*read*/; args[0] = each; }'),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'do-loop-write-after',
    source: frame('do { args/*read*/; args[0] = {}; } while (cond);'),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'pattern-default-before-source',
    source: frame('const { first = args[0] } = args/*read*/;'),
    answers: { byDefault: false, whenReached: false, bodiesOnly: false },
  },
  {
    id: 'read-in-pattern-default-write-after',
    source: frame('const { first = args/*read*/ } = {} as { first?: object }; args[0] = {};'),
    answers: { byDefault: false, whenReached: false, bodiesOnly: false },
  },
  {
    id: 'read-in-pattern-default-write-in-source',
    source: frame(
      'const { first = args/*read*/ } = (args[0] = {}, {} as { first?: object }); void first;',
    ),
    answers: { byDefault: false, whenReached: true, bodiesOnly: false },
  },
  {
    id: 'read-in-pattern-write-in-source-before',
    source: frame(
      'args[0] = {}; const { first = args/*read*/ } = {} as { first?: object }; void first;',
    ),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'assignment-pattern-read',
    source: frame(
      'let first: object | undefined; ({ first = args/*read*/ } = (args[0] = {}, {} as { first?: object })); void first;',
    ),
    answers: { byDefault: false, whenReached: true, bodiesOnly: false },
  },
  {
    id: 'closure-write-after-read',
    source: frame('const run = () => { args[0] = {}; }; args/*read*/; run();'),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'closure-write-never-called',
    source: frame('const run = () => { args[0] = {}; }; args/*read*/; void run;'),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'declaration-write-referenced',
    source: frame('function put() { args[0] = {}; } args/*read*/; put();'),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'declaration-write-unreferenced',
    source: frame('function put() { args[0] = {}; } args/*read*/;'),
    answers: { byDefault: false, whenReached: false, bodiesOnly: false },
  },
  {
    id: 'declaration-write-unreferenced-after',
    source: frame('args/*read*/; function put() { args[0] = {}; }'),
    answers: { byDefault: false, whenReached: false, bodiesOnly: false },
  },
  {
    id: 'read-in-closure-write-outside',
    source: frame('const look = () => args/*read*/; args[0] = {}; look();'),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'read-in-closure-write-before',
    source: frame('args[0] = {}; const look = () => args/*read*/; look();'),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'read-in-closure-write-in-sibling',
    source: frame(
      'const look = () => args/*read*/; const put = () => { args[0] = {}; }; look(); put();',
    ),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'immediate-closure-read',
    source: frame('args[0] = {}; (() => args/*read*/)();'),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'dead-branch-write-before',
    source: frame('if (false) { args[0] = {}; } args/*read*/;'),
    answers: { byDefault: false, whenReached: false, bodiesOnly: false },
  },
  {
    id: 'live-branch-write-before',
    source: frame('if (cond) { args[0] = {}; } args/*read*/;'),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'dead-branch-write-after',
    source: frame('args/*read*/; if (false) { args[0] = {}; }'),
    answers: { byDefault: false, whenReached: false, bodiesOnly: false },
  },
  {
    id: 'conditional-write-before',
    source: frame('cond ? (args[0] = {}) : 0; args/*read*/;'),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'alias-declaration-only',
    source: frame('const copy = args; args/*read*/; void copy;'),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'alias-declaration-chain',
    source: frame('const copy = args; args/*read*/; void copy;'),
    also: 'copy',
    answers: { byDefault: false, whenReached: false, bodiesOnly: false },
  },
  {
    id: 'alias-use-before-read',
    source: frame('const copy = args; void copy; args/*read*/;'),
    also: 'copy',
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'alias-written-after-read',
    source: frame('const copy = args; args/*read*/; copy[0] = {};'),
    also: 'copy',
    answers: { byDefault: false, whenReached: false, bodiesOnly: false },
  },
  {
    id: 'call-before-read',
    source: frame('items.push(args); args/*read*/;'),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'spread-before-read',
    source: frame('items.push(...args); args/*read*/;'),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'read-in-class-key',
    source: frame('class Holder { [args/*read*/.length] = 1; } args[0] = {}; void Holder;'),
    answers: { byDefault: false, whenReached: false, bodiesOnly: false },
  },
  {
    id: 'class-key-write-after',
    source: frame('class Holder { static [(args[0] = {}, "k")] = args/*read*/; } void Holder;'),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'static-block-read',
    source: frame('class Holder { static { args/*read*/; } } args[0] = {}; void Holder;'),
    answers: { byDefault: false, whenReached: false, bodiesOnly: false },
  },
  {
    id: 'instance-field-read',
    source: frame('class Holder { field = args/*read*/; } args[0] = {}; void Holder;'),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'try-finally-write-after',
    source: frame('try { args/*read*/; } finally { args[0] = {}; }'),
    answers: { byDefault: false, whenReached: false, bodiesOnly: false },
  },
  {
    id: 'catch-write-before',
    source: frame('try { throw error; } catch { args[0] = {}; } args/*read*/;'),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'switch-write-before',
    source: frame(
      'switch (items.length) { case 0: args[0] = {}; break; default: break; } args/*read*/;',
    ),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'label-loop-write-after',
    source: frame('outer: for (;;) { args/*read*/; args[0] = {}; break outer; }'),
    answers: { byDefault: false, whenReached: false, bodiesOnly: true },
  },
  {
    id: 'loop-write-then-break',
    source: frame('for (;;) { args/*read*/; args[0] = {}; break; }'),
    answers: { byDefault: false, whenReached: false, bodiesOnly: true },
  },
  {
    id: 'nested-function-loop',
    source: frame('const go = () => { for (;;) { args/*read*/; args[0] = {}; } }; go();'),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
  {
    id: 'type-query-use',
    source: frame('type Shape = typeof args; args/*read*/; void (0 as unknown as Shape);'),
    answers: { byDefault: false, whenReached: false, bodiesOnly: false },
  },
  {
    id: 'parenthesized-read',
    source: frame('args[0] = {}; (args/*read*/ as object[]);'),
    answers: { byDefault: true, whenReached: true, bodiesOnly: true },
  },
];

describe('what the uses of a tuple expose at a read of it', () => {
  it.each(CASES)('answers $id', ({ also, answers, source }) => {
    const found = {
      byDefault: exposed(source, { also, reached: 'loops' }),
      whenReached: exposed(source, { also, reached: true }),
      bodiesOnly: exposed(source, { also, reached: false }),
    };

    expect(found).toStrictEqual(answers);
  });

  const BOTH_SIDES = frame(
    `${'args[0] = error; '.repeat(10)}args/*read*/; ${'args[0] = error; '.repeat(10)}`,
  );

  it('lets uses the caller vouches for pass, from either side of the read', () => {
    const asked = { reached: 'loops' } as const;

    expect(exposed(BOTH_SIDES, { ...asked, unchanged: () => true })).toBe(false);
    expect(exposed(BOTH_SIDES, { ...asked, unchanged: (name, read) => name.pos > read.pos })).toBe(
      true,
    );
    expect(exposed(BOTH_SIDES, { ...asked, unchanged: (name, read) => name.pos < read.pos })).toBe(
      false,
    );
  });

  it('asks the caller about a use only where the use exposes the tuple', () => {
    const asked: Identifier[] = [];
    const found = exposed(BOTH_SIDES, {
      reached: 'loops',
      unchanged: (name) => {
        asked.push(name);
        return true;
      },
    });

    expect(found).toBe(false);
    expect(asked).toHaveLength(10);
  });
});

/** Writes `args[0] = error;` `count` times, then spreads the tuple into a native call. */
function writes(count: number): string {
  return frame(`${'args[0] = error; '.repeat(count)} return Reflect.get(...args);`);
}

/** The compile's reading of every node of a source, and the lookups of a name it makes. */
function lookupsOfFile(source: string): { readonly found: number; readonly lookups: number } {
  using api = openTypeScript();
  using parsed = parseModule(api, 'tuple-write-bindings.ts', source);
  vi.mocked(frameBindingOf).mockClear();
  let found = 0;
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedRead(node) !== undefined) found += 1;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return { found, lookups: vi.mocked(frameBindingOf).mock.calls.length };
}

/** The lookups of a name made by asking, at each of `count` writes, what the tuple's uses expose. */
function lookupsOfWrites(count: number): number {
  using api = openTypeScript();
  using parsed = parseModule(api, 'tuple-write-bindings.ts', writes(count));
  const names = identifiersOf(parsed.sourceFile).filter((name) => name.text === 'args');
  const tuple = bindingOf(names[0], 'args');
  vi.mocked(frameBindingOf).mockClear();
  const answers = names
    .filter((name) => name !== tuple.name)
    .map((name) => argumentArrayExposed(name, new Set([tuple])));

  expect(answers.slice(0, 1)).toStrictEqual([false]);
  expect(answers.slice(1)).not.toContain(false);

  return vi.mocked(frameBindingOf).mock.calls.length;
}

describe('the lookups of a name that writes into a tuple cost', () => {
  beforeEach(() => {
    vi.mocked(frameBindingOf).mockClear();
  });

  it.each([100, 200, 400])('resolves each name once for %i writes to a tuple', (count) => {
    expect(lookupsOfWrites(count)).toBeLessThanOrEqual(4 * count);
  });

  it.each([100, 200, 400])('reads a file of %i writes with lookups that follow it', (count) => {
    const { found, lookups } = lookupsOfFile(writes(count));

    expect(found).toBe(1);
    expect(lookups).toBeLessThanOrEqual(30 * count);
  });

  it('keeps what a write of data and of an error answer', () => {
    const data = frame(
      `${'args[0] = { stack: "fixed" }; '.repeat(50)} return Reflect.get(...args);`,
    );

    expect(lookupsOfFile(data).found).toBe(0);
    expect(lookupsOfFile(writes(1)).found).toBe(1);
    expect(lookupsOfFile(writes(50)).found).toBe(1);
  });
});
