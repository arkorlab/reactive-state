import {
  type Expression,
  isCallExpression,
  isIdentifier,
  isReturnStatement,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import {
  arrayWritesUnfollowed,
  writtenArrayElements,
} from '../src/compiler/framed-array-elements.ts';
import { framedArrayString, framedArrayText } from '../src/compiler/framed-arrays.ts';
import { framedEntriesCall, framedEntryValues } from '../src/compiler/framed-entry-values.ts';
import { UnfollowableError } from '../src/compiler/framed-getter-writes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A native object mutator (`Object.assign`, `Object.defineProperty`, `Object.defineProperties`, and
 * `Reflect.defineProperty`, called however the code writes the call) whose target may be an array the
 * compile follows leaves that array unfollowed: what it installs depends on the sources, descriptors,
 * getters and spreads it is handed, none of which is read, so the text conversion of the array is
 * refused whatever they are, an array of texts included. A mutator of any other object, and a write
 * the read comes before, change nothing.
 */
const HEAD =
  "function frames(error: Error, flag: boolean, source: Record<number, string>) { const labels = ['a', 'b']; const other = ['c'];";

const CONVERSIONS = [
  {
    id: 'assign-a-named-field-to-an-array-of-texts',
    source: `${HEAD} Object.assign(labels, { total: 2 }); return labels.join(','); }`,
    converts: true,
  },
  {
    id: 'assign-onto-a-fresh-literal',
    source: `function frames(error: Error) { const rows = Object.assign(['x'], { 0: 'safe' }); return String(rows); }`,
    converts: true,
  },
  {
    id: 'define-a-hidden-label',
    source: `${HEAD} Object.defineProperty(labels, 'label', { value: 'tags', enumerable: false }); return labels.join(' '); }`,
    converts: true,
  },
  {
    id: 'define-many',
    source: `${HEAD} Object.defineProperties(labels, { first: { value: 1 } }); return String(labels); }`,
    converts: true,
  },
  {
    id: 'reflect-define',
    source: `${HEAD} Reflect.defineProperty(labels, 'x', { value: 1 }); return String(labels); }`,
    converts: true,
  },
  {
    id: 'assign-installing-the-error',
    source: `${HEAD} Object.assign(labels, { 0: error }); return labels.join(','); }`,
    converts: true,
  },
  {
    id: 'assign-a-getter',
    source: `${HEAD} Object.assign(labels, { get 0() { return 'x'; } }); return labels.join(','); }`,
    converts: true,
  },
  {
    id: 'assign-a-source-the-compile-cannot-read',
    source: `${HEAD} Object.assign(labels, source); return labels.join(','); }`,
    converts: true,
  },
  {
    id: 'assign-a-spread-of-an-unread-source',
    source: `${HEAD} Object.assign(labels, { ...source }); return labels.join(','); }`,
    converts: true,
  },
  {
    id: 'define-a-descriptor-held-by-a-constant',
    source: `${HEAD} const descriptor = { value: 'x' }; Object.defineProperty(labels, 0, descriptor); return labels.join(','); }`,
    converts: true,
  },
  {
    id: 'define-a-descriptor-a-spread-copies',
    source: `${HEAD} Object.defineProperty(labels, 0, { ...{ value: 'x' } }); return labels.join(','); }`,
    converts: true,
  },
  {
    id: 'assign-past-the-last-index',
    source: `${HEAD} Object.assign(labels, { 4294967295: 'x' }); return labels.join(','); }`,
    converts: true,
  },
  {
    id: 'assign-in-a-branch',
    source: `${HEAD} if (flag) Object.assign(labels, { total: 2 }); return labels.join(','); }`,
    converts: true,
  },
  {
    id: 'assign-through-call',
    source: `${HEAD} Object.assign.call(null, labels, { total: 2 }); return labels.join(','); }`,
    converts: true,
  },
  {
    id: 'assign-through-apply',
    source: `${HEAD} Object.assign.apply(null, [labels, { total: 2 }]); return labels.join(','); }`,
    converts: true,
  },
  {
    id: 'assign-through-a-constant-alias',
    source: `${HEAD} const assign = Object.assign; assign(labels, { total: 2 }); return labels.join(','); }`,
    converts: true,
  },
  {
    id: 'assign-through-a-comma-callee',
    source: `${HEAD} (0, Object.assign)(labels, { total: 2 }); return labels.join(','); }`,
    converts: true,
  },
  {
    id: 'assign-through-the-result-of-another',
    source: `${HEAD} Object.assign(Object.assign(labels, {}), { total: 2 }); return labels.join(','); }`,
    converts: true,
  },
  {
    id: 'assign-through-a-condition',
    source: `${HEAD} Object.assign(flag ? labels : other, { total: 2 }); return labels.join(','); }`,
    converts: true,
  },
  {
    id: 'assign-through-new-object',
    source: `${HEAD} Object.assign(new Object(labels), { total: 2 }); return labels.join(','); }`,
    converts: true,
  },
  {
    id: 'assign-through-an-alias-of-the-array',
    source: `${HEAD} const alias = labels; Object.assign(alias, { total: 2 }); return labels.join(','); }`,
    converts: true,
  },
  {
    id: 'assign-before-a-template-converts-it',
    source: `${HEAD} Object.assign(labels, { total: 2 }); return String(labels); }`,
    converts: true,
  },
  {
    id: 'assign-and-a-replaced-join',
    source: `${HEAD} Object.assign(labels, { total: 2 }); labels.join = () => 'safe'; return labels.join(','); }`,
    converts: true,
  },
  {
    id: 'assign-another-array-pin',
    source: `${HEAD} Object.assign(other, { total: 2 }); return labels.join(','); }`,
    converts: false,
  },
  {
    id: 'assign-onto-an-object-pin',
    source: `${HEAD} const options = Object.assign({}, source, { extra: 1 }); return labels.join(',') + String(options.extra); }`,
    converts: false,
  },
  {
    id: 'assign-the-array-as-a-source-pin',
    source: `${HEAD} const copy = Object.assign({}, labels); return labels.join(',') + String(copy); }`,
    converts: false,
  },
  {
    id: 'define-on-an-object-pin',
    source: `${HEAD} const holder = {}; Object.defineProperty(holder, 'x', { value: 1 }); return labels.join(','); }`,
    converts: false,
  },
  {
    id: 'assign-after-the-conversion-pin',
    source: `${HEAD} const text = labels.join(','); Object.assign(labels, { total: 2 }); return text; }`,
    converts: false,
  },
  {
    id: 'push-and-an-indexed-write-pin',
    source: `${HEAD} labels.push('c'); labels[0] = 'z'; return labels.join(','); }`,
    converts: false,
  },
  {
    id: 'a-spread-copy-pin',
    source: `${HEAD} const copy = [...labels, 'c']; return labels.join(',') + copy.join(','); }`,
    converts: false,
  },
] as const;

describe('text conversion of an array a native object mutator names', () => {
  it.each(CONVERSIONS)('$id', ({ source, converts }) => {
    expect(convertsError(source)).toBe(converts);
  });
});

const READS = [
  {
    id: 'assign-installing-an-index',
    source: `${HEAD} Object.assign(labels, { 0: error }); return labels; }`,
    refused: true,
  },
  {
    id: 'define-a-named-field',
    source: `${HEAD} Object.defineProperty(labels, 'label', { value: 1 }); return labels; }`,
    refused: true,
  },
  {
    id: 'reflect-define',
    source: `${HEAD} Reflect.defineProperty(labels, 'label', { value: 1 }); return labels; }`,
    refused: true,
  },
  {
    id: 'assign-through-call',
    source: `${HEAD} Object.assign.call(null, labels, source); return labels; }`,
    refused: true,
  },
  {
    id: 'assign-through-the-result-of-another',
    source: `${HEAD} Object.assign(Object.assign(labels, {}), source); return labels; }`,
    refused: true,
  },
  {
    id: 'assign-in-a-loop-after-the-read',
    source: `${HEAD} for (let at = 0; at < 2; at += 1) { void labels; Object.assign(labels, source); } return labels; }`,
    refused: true,
  },
  {
    id: 'assign-through-the-result-then-pushed-to',
    source: `${HEAD} Object.assign(labels, {}).push(error); return labels; }`,
    refused: true,
  },
  {
    id: 'assign-another-array-pin',
    source: `${HEAD} Object.assign(other, { 0: error }); return labels; }`,
    refused: false,
  },
  {
    id: 'assign-an-object-pin',
    source: `${HEAD} const options = Object.assign({}, source); void options; return labels; }`,
    refused: false,
  },
  {
    id: 'push-pin',
    source: `${HEAD} labels.push(error); return labels; }`,
    refused: false,
  },
  {
    id: 'indexed-write-pin',
    source: `${HEAD} labels[1] = error; return labels; }`,
    refused: false,
  },
] as const;

describe('the elements written to an array a native object mutator names', () => {
  it.each(READS)('$id', ({ source, refused }) => {
    const found = readOf(source);

    expect(found.unfollowed).toBe(refused);
    expect(found.threw).toBe(refused);
  });
});

const TUPLES = [
  {
    id: 'assign-in-an-argument',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry, (Object.assign(entry, { 1: error }), ['other', 0])]); }",
    followed: false,
  },
  {
    id: 'define-in-an-argument',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; return Object.fromEntries([entry], Object.defineProperty(entry, 1, { value: error })); }",
    followed: false,
  },
  {
    id: 'assign-to-another-tuple-pin',
    source:
      "function frames(error: Error) { const entry: [string, unknown] = ['message', 'safe']; const other: [string, unknown] = ['x', 1]; return Object.fromEntries([entry], Object.assign(other, { 1: error })); }",
    followed: true,
  },
  {
    id: 'written-pairs-pin',
    source:
      "function frames(error: Error) { return Object.fromEntries([['message', 'safe'], ['other', error]]); }",
    followed: true,
  },
] as const;

describe('the entries of Object.fromEntries when the argument list mutates a tuple by a native', () => {
  it.each(TUPLES)('$id', ({ source, followed }) => {
    expect(entryValuesFollowed(source)).toBe(followed);
  });
});

/** The text conversions of the source: `join`, `toString`, `sort` and `String(array)`. */
function convertsError(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'array-mutators-refused.ts', source);
  const words = {
    error: (value: Expression, keys?: readonly string[]) => {
      const each = unwrapped(value);
      return (
        (keys === undefined || keys.length === 0) && isIdentifier(each) && each.text === 'error'
      );
    },
    typed: () => false,
  };
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (framedArrayText(node, words)) return true;
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === 'String' &&
      framedArrayString(node.arguments[0], words, node)
    )
      return true;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return false;
}

/** Whether the gate refuses the returned array, and whether reading its written elements throws. */
function readOf(source: string): { readonly unfollowed: boolean; readonly threw: boolean } {
  using api = openTypeScript();
  using parsed = parseModule(api, 'array-mutators-refused.ts', source);
  const read = returned(parsed.sourceFile);
  let threw = false;
  try {
    writtenArrayElements(read, read);
  } catch (error) {
    if (!(error instanceof UnfollowableError)) throw error;
    threw = true;
  }
  return { unfollowed: arrayWritesUnfollowed(read, read), threw };
}

function returned(root: Node): Expression {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isReturnStatement(node) && node.expression !== undefined && isIdentifier(node.expression))
      return node.expression;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no returned name');
}

/** Whether `Object.fromEntries` of the source gives values for `message`, or is left unfollowed. */
function entryValuesFollowed(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'array-mutators-refused.ts', source);
  const pending: Node[] = [parsed.sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isCallExpression(node) && framedEntriesCall(node))
      return framedEntryValues(node, 'message') !== undefined;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no Object.fromEntries call');
}
