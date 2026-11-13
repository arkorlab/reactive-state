import { isCallExpression, type CallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedEntriesCall, framedEntryValues } from '../src/compiler/framed-entry-values.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Code the argument list runs without a call of its own (a getter a read finds, an iterator a spread
 * takes, a `toString` or a `valueOf` a template or an operator coerces by, a setter an assignment
 * meets, a getter of an entry that `Object.fromEntries` itself reads) may write the tuple, as a call
 * may: where such code runs and a function elsewhere names the tuple, it is read where it is asked for.
 */
const CASES = [
  {
    id: 'getter-read-in-the-list',
    source:
      "function frames(error: Error, tag: (parts: unknown, ...rest: unknown[]) => unknown, proxy: any) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], entry, ['unused', { get x() { entry[1] = error; return 0; } }.x]]); }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'getter-read-by-an-element-access',
    source:
      "function frames(error: Error, tag: (parts: unknown, ...rest: unknown[]) => unknown, proxy: any) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], entry, ['unused', { get x() { entry[1] = error; return 0; } }['x']]]); }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'getter-run-by-a-spread-of-an-object',
    source:
      "function frames(error: Error, tag: (parts: unknown, ...rest: unknown[]) => unknown, proxy: any) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], entry, ['unused', { ...{ get x() { entry[1] = error; return 0; } } }]]); }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'getter-run-by-a-spread-of-a-list',
    source:
      "function frames(error: Error, tag: (parts: unknown, ...rest: unknown[]) => unknown, proxy: any) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], entry, ['unused', [...{ get length() { entry[1] = error; return 0; } } as any]]]); }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'to-string-run-by-a-template',
    source:
      // eslint-disable-next-line no-template-curly-in-string
      "function frames(error: Error, tag: (parts: unknown, ...rest: unknown[]) => unknown, proxy: any) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], entry, ['unused', `${{ toString() { entry[1] = error; return ''; } }}`]]); }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'to-primitive-run-by-a-template',
    source:
      // eslint-disable-next-line no-template-curly-in-string
      "function frames(error: Error, tag: (parts: unknown, ...rest: unknown[]) => unknown, proxy: any) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], entry, ['unused', `${{ [Symbol.toPrimitive]() { entry[1] = error; return ''; } }}`]]); }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'value-of-run-by-an-arithmetic',
    source:
      "function frames(error: Error, tag: (parts: unknown, ...rest: unknown[]) => unknown, proxy: any) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], entry, ['unused', +{ valueOf() { entry[1] = error; return 1; } }]]); }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'value-of-run-by-a-sum',
    source:
      "function frames(error: Error, tag: (parts: unknown, ...rest: unknown[]) => unknown, proxy: any) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], entry, ['unused', 1 + ({ valueOf() { entry[1] = error; return 1; } } as any)]]); }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'iterator-run-by-a-spread-of-a-list',
    source:
      "function frames(error: Error, tag: (parts: unknown, ...rest: unknown[]) => unknown, proxy: any) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], entry, ['unused', [...{ *[Symbol.iterator]() { entry[1] = error;  } }]]]); }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'has-instance-run-by-instanceof',
    source:
      "function frames(error: Error, tag: (parts: unknown, ...rest: unknown[]) => unknown, proxy: any) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], entry, ['unused', 1 instanceof ({ [Symbol.hasInstance]() { entry[1] = error; return true; } } as any)]]); }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'key-run-by-a-computed-name',
    source:
      "function frames(error: Error, tag: (parts: unknown, ...rest: unknown[]) => unknown, proxy: any) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], entry, ['unused', { [{ toString() { entry[1] = error; return 'k'; } } as any]: 1 }]]); }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'setter-run-by-an-assignment',
    source:
      "function frames(error: Error, tag: (parts: unknown, ...rest: unknown[]) => unknown, proxy: any) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], entry, ['unused', ({ set x(value: unknown) { entry[1] = error; } }.x = 1)]]); }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'getter-in-an-entry-the-call-reads',
    source:
      "function frames(error: Error, tag: (parts: unknown, ...rest: unknown[]) => unknown, proxy: any) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([{ get 0() { entry[1] = error; return 'other'; }, 1: 0 } as any, entry]); }",
    key: 'message',
    values: ["{ get 0() { entry[1] = error; return 'other'; }, 1: 0 }:1", 'entry:1'],
  },
  {
    id: 'getter-in-an-earlier-entry-with-a-value',
    source:
      "function frames(error: Error, tag: (parts: unknown, ...rest: unknown[]) => unknown, proxy: any) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], { get 0() { entry[1] = error; return 'other'; }, 1: 0 } as any, entry]); }",
    key: 'message',
    values: ["{ get 0() { entry[1] = error; return 'other'; }, 1: 0 }:1", 'entry:1', 'error:'],
  },
  {
    id: 'iterator-in-a-spread-entry',
    source:
      "function frames(error: Error, tag: (parts: unknown, ...rest: unknown[]) => unknown, proxy: any) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([...({ *[Symbol.iterator]() { entry[1] = error;  } } as any), entry]); }",
    key: 'message',
    values: ['{ *[Symbol.iterator]() { entry[1] = error;  } }:0.1', 'entry:1'],
  },
  {
    id: 'getter-in-an-entry-the-tuple-follows-a-pin',
    source:
      "function frames(error: Error, tag: (parts: unknown, ...rest: unknown[]) => unknown, proxy: any) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, { get 0() { entry[1] = error; return 'other'; }, 1: 0 } as any]); }",
    key: 'message',
    values: ["{ get 0() { entry[1] = error; return 'other'; }, 1: 0 }:1", 'entry:1'],
  },
  {
    id: 'getter-that-does-not-name-the-tuple-pin',
    source:
      "function frames(error: Error, tag: (parts: unknown, ...rest: unknown[]) => unknown, proxy: any) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], entry, ['unused', { get x() { return 0; } }.x]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'stored-arrow-with-no-code-run-pin',
    source:
      "function frames(error: Error, tag: (parts: unknown, ...rest: unknown[]) => unknown, proxy: any) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], entry, ['unused', () => { entry[1] = error;  }]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'literal-arguments-pin',
    source:
      "function frames(error: Error, tag: (parts: unknown, ...rest: unknown[]) => unknown, proxy: any) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], entry, ['unused', 1]]); }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'tagged-template-run-with-a-function-that-names-the-tuple',
    source:
      "function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['message', 'safe']; const out = Object.fromEntries([['message', error], entry, ['unused', tag`x`]]); function tag() { entry[1] = error; } return out; }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'tagged-template-run-with-a-function-that-does-not-name-the-tuple-pin',
    source:
      "function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['message', 'safe']; const out = Object.fromEntries([['message', error], entry, ['unused', tag`x`]]); function tag() { return 1; } return out; }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'destructuring-default-run-in-an-assignment',
    source:
      "function frames(error: Error, flag: boolean) { const entry: [string, unknown] = ['message', 'safe']; let sink: unknown; const out = Object.fromEntries([['message', error], entry, ['unused', ([sink = reviewed()] = [])]]); function reviewed() { entry[1] = error; } return out; }",
    key: 'message',
    values: ['entry:1', 'error:'],
  },
  {
    id: 'to-string-of-a-key-run-by-the-call',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], [{ toString() { entry[1] = error; return 'other'; } }, 0], entry]); }",
    key: 'message',
    values: ['0:', 'entry:1', 'error:'],
  },
  {
    id: 'value-of-of-a-key-run-by-the-call',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], [{ valueOf() { entry[1] = error; return 'other'; } }, 0], entry]); }",
    key: 'message',
    values: ['0:', 'entry:1', 'error:'],
  },
  {
    id: 'to-primitive-of-a-key-run-by-the-call',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], [{ [Symbol.toPrimitive]() { entry[1] = error; return 'other'; } }, 0], entry]); }",
    key: 'message',
    values: ['0:', 'entry:1', 'error:'],
  },
  {
    id: 'arrow-to-string-of-a-key-run-by-the-call',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], [{ toString: () => { entry[1] = error; return 'other'; } }, 0], entry]); }",
    key: 'message',
    values: ['0:', 'entry:1', 'error:'],
  },
  {
    id: 'inherited-to-string-of-a-key-run-by-the-call',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], [{ __proto__: { toString() { entry[1] = error; return 'other'; } } }, 0], entry]); }",
    key: 'message',
    values: ['0:', 'entry:1', 'error:'],
  },
  {
    id: 'key-that-may-be-an-object-with-a-function-elsewhere',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; const out = Object.fromEntries([['message', error], [key, 0], entry]); elsewhere(); return out; function elsewhere() { entry[1] = error; } }",
    key: 'message',
    values: ['0:', 'entry:1', 'error:'],
  },
  {
    id: 'key-of-a-string-type-with-a-function-elsewhere-pin',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; const out = Object.fromEntries([['message', error], [name, 0], entry]); elsewhere(); return out; function elsewhere() { entry[1] = error; } }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'key-of-a-written-text-with-a-function-elsewhere-pin',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; const out = Object.fromEntries([['message', error], ['other', 0], entry]); elsewhere(); return out; function elsewhere() { entry[1] = error; } }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'key-of-a-constant-text-with-a-function-elsewhere-pin',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; const label = 'other'; const out = Object.fromEntries([['message', error], [label, 0], entry]); elsewhere(); return out; function elsewhere() { entry[1] = error; } }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'key-of-a-number-with-a-function-elsewhere-pin',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; const out = Object.fromEntries([['message', error], [1, 0], entry]); elsewhere(); return out; function elsewhere() { entry[1] = error; } }",
    key: 'message',
    values: ["'safe':"],
  },
  {
    id: 'hook-in-the-value-slot-pin',
    source:
      "function frames(error: Error, name: string, key: unknown) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([['message', error], ['other', { toString() { entry[1] = error; return 'x'; } }], entry]); }",
    key: 'message',
    values: ["'safe':"],
  },
] as const;

describe('entry tuples code the argument list runs by no call', () => {
  it.each(CASES)('$id', ({ source, key, values }) => {
    expect(selectedValues(source, key)).toStrictEqual(values);
  });
});

/** The values the source's `Object.fromEntries` call may install under the key, in text order. */
function selectedValues(source: string, key: string): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'getter-effects.ts', source);
  return framedEntryValues(entriesCall(parsed.sourceFile), key)
    ?.map((each) => `${each.value.getText()}:${each.keys.join('.')}`)
    .toSorted((left, right) => left.localeCompare(right));
}

function entriesCall(root: Node): CallExpression {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isCallExpression(node) && framedEntriesCall(node)) return node;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no Object.fromEntries call');
}
