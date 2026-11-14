import {
  type Expression,
  isIdentifier,
  isSpreadElement,
  type Node,
  type SpreadElement,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { writtenList } from '../src/compiler/framed-selected-sources.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A list is what its literal wrote only where nothing but a read of it is made. A member written
 * below an entry of it (`list[0].x = error`, `list[1].push(error)`, `delete list[0].x`) changes the
 * entry the list holds, as a write to the list does, and the entries that a spread of it hands on
 * are then no longer what the literal wrote. A read of a member below an entry changes nothing.
 */
const HEAD = "const list: any[] = [{ x: 'safe', n: 1, y: { z: 1 } }, ['a']];";

const WRITES = [
  { id: 'field-assigned', body: 'list[0].x = error;' },
  { id: 'element-assigned', body: 'list[1][0] = error;' },
  { id: 'nested-field-assigned', body: 'list[0].y.z = error;' },
  { id: 'element-key-assigned', body: "list[0]['x'] = error;" },
  { id: 'field-assigned-by-a-logical-assignment', body: 'list[0].x ||= error;' },
  { id: 'field-assigned-by-a-compound-assignment', body: 'list[0].n += 1;' },
  { id: 'field-incremented', body: 'list[0].n++;' },
  { id: 'field-decremented-first', body: '--list[0].n;' },
  { id: 'field-deleted', body: 'delete list[0].x;' },
  { id: 'nested-field-deleted', body: 'delete list[0].y.z;' },
  { id: 'field-written-by-an-array-pattern', body: '[list[0].x] = [error];' },
  { id: 'field-written-by-an-object-pattern', body: '({ key: list[0].x } = { key: error });' },
  { id: 'field-written-by-a-loop-head', body: 'for (list[0].x of [error]) { }' },
  { id: 'entry-pushed-to', body: 'list[1].push(error);' },
  { id: 'entry-sorted', body: 'list[1].sort();' },
  { id: 'entry-filled', body: 'list[1].fill(error);' },
  { id: 'entry-spliced', body: 'list[1].splice(0, 1, error);' },
  {
    id: 'entry-handed-to-a-callback-that-takes-it',
    body: 'list[1].map((item: any, at: number, whole: any[]) => whole.push(error));',
  },
  { id: 'field-assigned-under-parentheses', body: '(list[0].x) = error;' },
  { id: 'entry-parenthesized', body: '(list[0]).x = error;' },
  { id: 'entry-cast', body: '(list[0] as any).x = error;' },
  { id: 'entry-non-null', body: 'list[0]!.x = error;' },
  { id: 'entry-angle-cast', body: '(<any>list[0]).x = error;' },
  { id: 'field-assigned-under-a-satisfies', body: '(list[0].x satisfies unknown) = error;' },
  { id: 'entry-pushed-to-under-parentheses', body: '(list[1].push)(error);' },
  { id: 'entry-pushed-to-through-a-cast', body: '(list[1].push as any)(error);' },
  { id: 'a-write-to-the-list-itself', body: 'list[0] = error;' },
  { id: 'a-push-to-the-list-itself', body: 'list.push(error);' },
] as const;

const READS = [
  { id: 'field-read', body: 'void list[0].x;' },
  { id: 'nested-field-read', body: 'void list[0].y.z;' },
  { id: 'element-read', body: 'void list[1][0];' },
  { id: 'entry-read', body: 'void list[0];' },
  { id: 'field-read-under-parentheses', body: 'void (list[0]).x;' },
  { id: 'field-read-through-a-cast', body: 'void (list[0] as any).x;' },
  { id: 'field-read-by-an-addition', body: 'let total = 0; total += list[0].n;' },
  { id: 'field-read-on-the-right-of-an-assignment', body: 'let held: any; held = list[0].x;' },
  { id: 'field-read-by-a-conditional', body: 'void (list[0].n ? list[0].x : list[0].y);' },
  { id: 'field-read-by-typeof', body: 'void typeof list[0].x;' },
  { id: 'field-read-by-a-comparison', body: 'void (list[0].n === 1);' },
  { id: 'entry-joined', body: 'list[1].join();' },
  { id: 'entry-sliced', body: 'list[1].slice();' },
  { id: 'entry-searched', body: "list[1].includes('a');" },
  { id: 'field-converted', body: 'list[0].x.toString();' },
  {
    id: 'entry-handed-to-a-callback-that-does-not-take-it',
    body: 'list[1].map((item: any) => item);',
  },
  { id: 'entry-iterated', body: 'for (const each of list[1]) { void each; }' },
] as const;

describe('a member written below an entry of a list a spread copies', () => {
  it.each(WRITES)('$id', ({ body }) => {
    const source = `function frames(error: any) { ${HEAD} ${body} return [...list]; }`;

    expect(isWritten(source)).toBe(false);
  });

  it.each(READS)('$id is a read of the list', ({ body }) => {
    const source = `function frames(error: any) { ${HEAD} ${body} return [...list]; }`;

    expect(isWritten(source)).toBe(true);
  });
});

/** Whether the list the source spreads is read as its literal wrote it. */
function isWritten(source: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'element-writes.ts', source);
  return writtenList(spreadOf(parsed.sourceFile).expression) !== undefined;
}

function spreadOf(root: Node): SpreadElement & { readonly expression: Expression } {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isSpreadElement(node) && isIdentifier(node.expression)) return node;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no spread of a name');
}
