import { isCallExpression, type CallExpression, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedEntriesCall, framedEntryValues } from '../src/compiler/framed-entry-values.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A getter the copy of a spread runs writes into its receiver through `super` as it does through
 * `this`: an assignment to a member of `super` sets the field on the receiver, and a call of one
 * runs a method on it.
 */
const ENTRY = "const entry: [string, unknown] = ['message', 'safe'];";

const CASES = [
  {
    id: 'super-write-keeps-the-written-value',
    source: `function frames(error: Error, name: string, first: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: 'kept', ...{ get trigger() { super.field = error; return 0; } } })); }`,
    key: 'message',
    values: ["'kept':", "'safe':", '0:', 'error:'],
  },
  {
    id: 'super-element-write-keeps-the-written-value',
    source: `function frames(error: Error, name: string, first: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: 'kept', ...{ get trigger() { super['field'] = error; return 0; } } })); }`,
    key: 'message',
    values: ["'kept':", "'safe':", '0:', 'error:'],
  },
  {
    id: 'super-computed-write-keeps-the-written-value',
    source: `function frames(error: Error, name: string, first: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: 'kept', ...{ get trigger() { super[name] = error; return 0; } } })); }`,
    key: 'message',
    values: ["'kept':", "'safe':", '0:', 'error:'],
  },
  {
    id: 'super-logical-write-keeps-the-written-value',
    source: `function frames(error: Error, name: string, first: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: 'kept', ...{ get trigger() { super.field ||= error; return 0; } } })); }`,
    key: 'message',
    values: ["'kept':", "'safe':", '0:', 'error:'],
  },
  {
    id: 'super-write-in-an-arrow-keeps-the-written-value',
    source: `function frames(error: Error, name: string, first: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: 'kept', ...{ get trigger() { (() => { super.field = error; })(); return 0; } } })); }`,
    key: 'message',
    values: ["'kept':", "'safe':", '0:', 'error:'],
  },
  {
    id: 'super-method-call-refuses',
    source: `function frames(error: Error, name: string, first: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: 'kept', ...{ get trigger() { super.reset(); return 0; } } })); }`,
    key: 'message',
    values: undefined,
  },
  {
    id: 'super-element-method-call-refuses',
    source: `function frames(error: Error, name: string, first: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: 'kept', ...{ get trigger() { super['reset'](); return 0; } } })); }`,
    key: 'message',
    values: undefined,
  },
  {
    id: 'super-write-through-a-pattern-refuses',
    source: `function frames(error: Error, name: string, first: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: 'kept', ...{ get trigger() { [super.field] = [error]; return 0; } } })); }`,
    key: 'message',
    values: undefined,
  },
  {
    id: 'super-in-an-inherited-getter-refuses',
    source: `function frames(error: Error, name: string, first: string) { ${ENTRY} let sink: unknown; return Object.fromEntries([entry], ({ [first]: sink, [name]: entry[1] } = { __proto__: { get trigger() { super.field = error; return 0; } }, field: 'kept' })); }`,
    key: 'message',
    values: undefined,
  },
  {
    id: 'super-read-pin',
    source: `function frames(error: Error, name: string, first: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: 'kept', ...{ get trigger() { return super.field; } } })); }`,
    key: 'message',
    values: ["'kept':", "'safe':", 'super.field:'],
  },
  {
    id: 'super-in-a-method-of-the-getter-pin',
    source: `function frames(error: Error, name: string, first: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: 'kept', ...{ get trigger() { const inner = { method() { super.field = error; } }; return inner; } } })); }`,
    key: 'message',
    values: ["'kept':", "'safe':", 'inner:'],
  },
  {
    id: 'super-write-where-the-prototype-has-a-setter-refuses',
    source: `function frames(error: Error, name: string, first: string) { ${ENTRY} let sink: unknown; return Object.fromEntries([entry], ({ [first]: sink, [name]: entry[1] } = { __proto__: { set field(value: unknown) { this.other = error; } }, other: 'kept', get trigger() { super.field = 0; return 0; } })); }`,
    key: 'message',
    values: undefined,
  },
  {
    id: 'super-write-where-the-file-may-change-the-prototype-refuses',
    source: `function frames(error: Error, name: string, proto: object) { ${ENTRY} Object.setPrototypeOf(entry, proto); return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: 'kept', ...{ get trigger() { super.field = error; return 0; } } })); }`,
    key: 'message',
    values: undefined,
  },
  {
    id: 'super-read-where-the-prototype-may-have-a-getter-refuses',
    source: `function frames(error: Error, name: string, key: string) { ${ENTRY} return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: 'kept', ...{ get trigger() { return super[key]; } }, ['__proto__']: null })); }`,
    key: 'message',
    values: undefined,
  },
  {
    id: 'super-write-where-the-prototype-is-computed-refuses',
    source: `function frames(error: Error, name: string) { ${ENTRY} const holder: any = {}; return Object.fromEntries([entry], ({ [name]: entry[1] } = { field: 'kept', get trigger() { super.field = error; return 0; }, ...Object[name](holder) })); }`,
    key: 'message',
    values: undefined,
  },
] as const;

describe('entry tuple slots a getter writes through super', () => {
  it.each(CASES)('$id', ({ source, key, values }) => {
    expect(selectedValues(source, key)).toStrictEqual(values);
  });
});

/** The values the source's `Object.fromEntries` call may install under the key, in text order. */
function selectedValues(source: string, key: string): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'super-getter-writes.ts', source);
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
