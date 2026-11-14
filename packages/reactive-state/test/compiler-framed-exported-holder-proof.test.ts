import {
  type Expression,
  isFunctionDeclaration,
  isIdentifier,
  isPropertyAccessExpression,
  isVariableDeclaration,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { sourceArrayFunction } from '../src/compiler/framed-array-functions.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A module that exports an object hands it to every module that imports it, and an importer can
 * replace a method of it before it calls a function of this one that reads the method later: the
 * method the object was written with is not what such a read sees. A read where the module is
 * evaluated, before any importer has run, an object that is not exported, one listed in
 * `export { … }` and an exported function, which an importer cannot assign, are as they were.
 */
const METHODS = [
  {
    id: 'reviewed-exported-holder-read-by-an-exported-function',
    source:
      "export const methods = { join() { return 'fixed'; } }; export function read() { return methods.join; }",
    read: 'methods.join',
    custom: false,
  },
  {
    id: 'exported-holder-read-by-a-function-of-the-module',
    source:
      "export const methods = { join() { return 'fixed'; } }; function read() { return methods.join; } void read;",
    read: 'methods.join',
    custom: false,
  },
  {
    id: 'exported-holder-read-by-an-arrow',
    source:
      "export const methods = { join() { return 'fixed'; } }; export const read = () => methods.join;",
    read: 'methods.join',
    custom: false,
  },
  {
    id: 'method-of-a-nested-object-of-an-exported-holder',
    source:
      "export const methods = { inner: { join() { return 'fixed'; } } }; export function read() { return methods.inner.join; }",
    read: 'methods.inner.join',
    custom: false,
  },
  {
    id: 'exported-holder-listed-in-an-export-pin',
    source:
      "const methods = { join() { return 'fixed'; } }; export { methods }; export function read() { return methods.join; }",
    read: 'methods.join',
    custom: false,
  },
  {
    id: 'holder-not-exported-pin',
    source:
      "const methods = { join() { return 'fixed'; } }; export function read() { return methods.join; }",
    read: 'methods.join',
    custom: true,
  },
  {
    id: 'exported-holder-read-where-the-module-is-evaluated-pin',
    source: "export const methods = { join() { return 'fixed'; } }; const taken = methods.join;",
    read: 'methods.join',
    custom: true,
  },
  {
    id: 'another-holder-exported-pin',
    source:
      "export const other = { join() { return 'other'; } }; const methods = { join() { return 'fixed'; } }; void other; export function read() { return methods.join; }",
    read: 'methods.join',
    custom: true,
  },
  {
    id: 'exported-function-read-by-an-exported-function-pin',
    source:
      "export function custom() { return 'fixed'; } export function read() { const values = [1]; return [values, custom]; }",
    read: 'custom',
    custom: true,
  },
];

/** Every node of `root`'s tree. */
function nodesOf(root: Node): readonly Node[] {
  const nodes: Node[] = [];
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    nodes.push(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return nodes;
}

/** The read of the written `text`, a member path or a name, the one such. */
function readOf(root: Node, text: string): Expression {
  const reads = nodesOf(root).filter((node): node is Expression => {
    return (
      (isPropertyAccessExpression(node) || isIdentifier(node)) &&
      node.getText() === text &&
      !isPropertyAccessExpression(node.parent) &&
      !(isFunctionDeclaration(node.parent) && node.parent.name?.pos === node.pos) &&
      !(isVariableDeclaration(node.parent) && node.parent.name.pos === node.pos)
    );
  });
  const [read] = reads.toSorted((a, b) => b.pos - a.pos);
  if (read === undefined) throw new Error(`no read of ${text}`);
  return read;
}

describe('a method read by a function of a module that exports its holder', () => {
  it.each(METHODS)('$id', ({ source, read, custom }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'exported-holder-proof.ts', source);

    expect(sourceArrayFunction(readOf(parsed.sourceFile, read))).toBe(custom);
  });
});
