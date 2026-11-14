import {
  type CallExpression,
  type Expression,
  type FunctionLikeDeclaration,
  type GetAccessorDeclaration,
  type Identifier,
  isCallExpression,
  isElementAccessExpression,
  isFunctionExpression,
  isFunctionLikeDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isVariableDeclaration,
  type Node,
  type ObjectLiteralExpression,
  type SourceFile,
  type VariableDeclaration,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { handsArray } from '../src/compiler/framed-array-callbacks.ts';
import {
  arrayWritesUnfollowed,
  writtenArrayElements,
} from '../src/compiler/framed-array-elements.ts';
import { defaultArrayComparison } from '../src/compiler/framed-array-sorting.ts';
import { writtenArrayWords } from '../src/compiler/framed-array-word-origins.ts';
import { framedReceiverDispatch } from '../src/compiler/framed-at-methods.ts';
import { accessorWrites } from '../src/compiler/framed-getter-writes.ts';
import { iteratorPrefixQuiet } from '../src/compiler/framed-iterator-guards.ts';
import { knownUsesOnly } from '../src/compiler/framed-known-mentions.ts';
import { namesThis } from '../src/compiler/framed-this-functions.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * TypeScript counts the expression a class extends (`extends make()`, `extends this.Base`), and an
 * instantiation expression (`make<T>()`), among its type nodes (`ExpressionWithTypeArguments`), though
 * both are evaluated where they stand: the class's superclass expression where the class is defined, with
 * the `this`, the `arguments` and the names of the code around it (ECMA-262, ClassDefinitionEvaluation).
 * A walk that leaves every type node out leaves out what they do. A name, or a name with type arguments
 * (`extends Base<T>`), runs nothing a call or a read does not, and a type annotation stays out.
 */
const PRELUDE =
  'declare const hooks: any; declare const Base: any; declare function make<T = unknown>(...rest: unknown[]): any;';

const WINDOW = [
  { id: 'a-call', heritage: 'make()', quiet: false },
  { id: 'a-parenthesised-call', heritage: '(make())', quiet: false },
  { id: 'an-instantiated-call', heritage: 'make<string>()', quiet: false },
  { id: 'a-member-read', heritage: 'hooks.base', quiet: false },
  { id: 'an-instantiated-member-read', heritage: 'hooks.base<string>', quiet: false },
  { id: 'a-comma-before-a-name', heritage: '(make(), Base)', quiet: false },
  { id: 'a-name-pin', heritage: 'Base', quiet: true },
  { id: 'a-parenthesised-name-pin', heritage: '(Base)', quiet: true },
  { id: 'a-name-with-type-arguments-pin', heritage: 'Base<string>', quiet: true },
] as const;

describe('the extends clause of a class between a source and its iterator', () => {
  it.each(WINDOW)('$id', ({ heritage, quiet }) => {
    const between = `class Derived extends ${heritage} {} void Derived;`;
    const source = `${PRELUDE} function frames() { const set = new Set([1, 2]); ${between} return set[Symbol.iterator](); }`;

    expect(windowQuiet(source)).toBe(quiet);
  });

  it('an implements clause is a type alone', () => {
    const between = 'class Derived implements Shape {} void Derived;';
    const source = `${PRELUDE} interface Shape { size?: number } function frames() { const set = new Set([1, 2]); ${between} return set[Symbol.iterator](); }`;

    expect(windowQuiet(source)).toBe(true);
  });
});

const THIS = [
  { id: 'this-read', heritage: 'this.Base', named: true },
  { id: 'this-itself', heritage: '(this)', named: true },
  { id: 'this-in-a-call-argument', heritage: 'make(this)', named: true },
  { id: 'this-with-type-arguments', heritage: 'this.Base<string>', named: true },
  { id: 'this-in-a-class-expression', heritage: 'this.Base', named: true, expression: true },
  { id: 'a-call-without-this-pin', heritage: 'make()', named: false },
  { id: 'a-name-pin', heritage: 'Base', named: false },
  { id: 'a-name-with-type-arguments-pin', heritage: 'Base<string>', named: false },
] as const;

describe('a function that names this in the extends clause of a class', () => {
  it.each(THIS)('$id', (row) => {
    const { heritage, named } = row;
    const body =
      'expression' in row
        ? `return class extends ${heritage} {};`
        : `class Derived extends ${heritage} {} return Derived;`;
    const source = `${PRELUDE} const holder = { method() { ${body} } };`;

    expect(thisNamed(source)).toBe(named);
  });
});

const DISPATCH = [
  { id: 'receiver-member-read', heritage: 'holder.Base', dispatches: true },
  { id: 'receiver-in-a-call-argument', heritage: 'make(holder)', dispatches: true },
  { id: 'receiver-with-type-arguments', heritage: 'holder<string>', dispatches: true },
  { id: 'a-call-pin', heritage: 'make()', dispatches: false },
  { id: 'a-name-pin', heritage: 'Base', dispatches: false },
  { id: 'a-name-with-type-arguments-pin', heritage: 'Base<string>', dispatches: false },
] as const;

describe('a method that names its receiver in the extends clause of a class', () => {
  it.each(DISPATCH)('$id', ({ heritage, dispatches }) => {
    const source = `${PRELUDE} declare const holder: any; const method = function () { class Derived extends ${heritage} {} return Derived; };`;

    expect(receiverDispatched(source)).toBe(dispatches);
  });
});

const MENTIONS = [
  { id: 'handed-to-a-call', heritage: 'make(values)', known: false },
  { id: 'handed-to-an-instantiated-call', heritage: 'make<string>(values)', known: false },
  { id: 'stored-by-a-comma', heritage: '(hooks.kept = values, Base)', known: false },
  { id: 'no-mention-pin', heritage: 'Base', known: true },
  { id: 'no-mention-with-type-arguments-pin', heritage: 'Base<string>', known: true },
] as const;

describe('a constant mentioned in the extends clause of a class', () => {
  it.each(MENTIONS)('$id', ({ heritage, known }) => {
    const source = `${PRELUDE} const values = [1, 2]; class Derived extends ${heritage} {} void Derived; void values.length;`;

    expect(usesKnown(source)).toBe(known);
  });
});

const SORTS = [
  { id: 'alias-handed-to-a-call', heritage: 'make(same)', defaults: true },
  { id: 'alias-handed-to-an-instantiated-call', heritage: 'make<string>(same)', defaults: true },
  { id: 'alias-member-read', heritage: 'same.constructor', defaults: true },
  { id: 'no-mention-pin', heritage: 'Base', defaults: false },
  { id: 'no-mention-with-type-arguments-pin', heritage: 'Base<string>', defaults: false },
] as const;

describe('a small array an extends clause mentions before it is sorted', () => {
  it.each(SORTS)('$id', ({ heritage, defaults }) => {
    const source = `${PRELUDE} const single = [1]; const same = single; class Derived extends ${heritage} {} void Derived; same.sort();`;

    expect(sortsByDefault(source)).toBe(defaults);
  });
});

const WORDS = [
  { id: 'handed-to-a-call', heritage: 'make(words)', written: false },
  { id: 'handed-to-an-instantiated-call', heritage: 'make<string>(words)', written: false },
  { id: 'mutated-through-a-member', heritage: '(words.push(hooks), Base)', written: false },
  { id: 'no-mention-pin', heritage: 'Base', written: true },
  { id: 'no-mention-with-type-arguments-pin', heritage: 'Base<string>', written: true },
] as const;

describe('a literal of words an extends clause mentions before it is read', () => {
  it.each(WORDS)('$id', ({ heritage, written }) => {
    const source = `${PRELUDE} const words = ['a', 'b']; class Derived extends ${heritage} {} void Derived; void words[0];`;

    expect(wordsWritten(source)).toBe(written);
  });
});

const SETTERS = [
  { id: 'argument-handed-to-a-call', heritage: 'make(value)', followed: false },
  { id: 'argument-with-type-arguments', heritage: 'value<string>', followed: false },
  { id: 'argument-member-read', heritage: 'value.Base', followed: false },
  { id: 'the-arguments-object', heritage: 'make(arguments)', followed: false },
  { id: 'argument-unread-pin', heritage: 'Base', followed: true },
  { id: 'argument-unread-with-type-arguments-pin', heritage: 'Base<string>', followed: true },
] as const;

describe('a setter that reads its argument in the extends clause of a class', () => {
  it.each(SETTERS)('$id', ({ heritage, followed }) => {
    const source = `${PRELUDE} const object = { get total() { this.cached = 1; return 0; }, set cached(value) { class Derived extends ${heritage} {} void Derived; } };`;

    expect(settersFollowed(source)).toBe(followed);
  });
});

const CALLBACKS = [
  { id: 'arguments-in-a-call', heritage: 'make(arguments)', hands: true },
  { id: 'arguments-element', heritage: 'arguments[2]', hands: true },
  { id: 'arguments-with-type-arguments', heritage: 'make<string>(arguments)', hands: true },
  { id: 'no-arguments-pin', heritage: 'make()', hands: false },
  { id: 'a-name-pin', heritage: 'Base', hands: false },
  { id: 'a-name-with-type-arguments-pin', heritage: 'Base<string>', hands: false },
] as const;

describe('a callback that names arguments in the extends clause of a class', () => {
  it.each(CALLBACKS)('$id', ({ heritage, hands }) => {
    const source = `${PRELUDE} const list = [1, 2]; list.map(function () { class Derived extends ${heritage} {} return Derived; });`;

    expect(callbackHandsArray(source)).toBe(hands);
  });
});

const ELEMENTS = [
  { id: 'element-written-in-a-comma', heritage: '(array[0] = 5, Base)', written: true },
  { id: 'element-written-in-a-call-argument', heritage: 'make(array[0] = 5)', written: true },
  { id: 'element-pushed', heritage: '(array.push(5), Base)', written: true },
  {
    id: 'element-written-with-type-arguments',
    heritage: 'make<string>(array[0] = 5)',
    written: true,
  },
  { id: 'no-write-pin', heritage: 'Base', written: false },
  { id: 'no-write-with-type-arguments-pin', heritage: 'Base<string>', written: false },
] as const;

const OPAQUE = [
  { id: 'assigned-from-a-call', write: 'Object.assign(array, make())' },
  { id: 'pushed-through-apply', write: 'array.push.apply(array, hooks)' },
] as const;

describe('an element written in the extends clause of a class before a read', () => {
  it.each(ELEMENTS)('$id', ({ heritage, written }) => {
    const source = `${PRELUDE} const array = [1, 2]; class Derived extends ${heritage} {} void Derived; void array[0];`;

    expect(elementsWritten(source)).toBe(written);
  });

  it.each(OPAQUE)('$id is not followed as a statement', ({ write }) => {
    const source = `${PRELUDE} const array = [1, 2]; ${write}; void array[0];`;

    expect(writesUnfollowed(source)).toBe(true);
  });

  it.each(OPAQUE)('$id is not followed in the extends clause of a class', ({ write }) => {
    const source = `${PRELUDE} const array = [1, 2]; class Derived extends (${write}, Base) {} void Derived; void array[0];`;

    expect(writesUnfollowed(source)).toBe(true);
  });
});

function inModule<T>(source: string, read: (file: SourceFile) => T): T {
  using api = openTypeScript();
  using parsed = parseModule(api, 'heritage.ts', source);
  return read(parsed.sourceFile);
}

function windowQuiet(source: string): boolean {
  return inModule(source, (file) => {
    const created = find(file, (node): node is Expression => isNewExpression(node));
    const acquisition = find(
      file,
      (node): node is CallExpression =>
        isCallExpression(node) && node.getText().includes('Symbol.iterator'),
    );
    return iteratorPrefixQuiet(created, acquisition);
  });
}

function thisNamed(source: string): boolean {
  return inModule(source, (file) => {
    return namesThis(
      find(
        file,
        (node): node is FunctionLikeDeclaration =>
          isFunctionLikeDeclaration(node) && node.getText().startsWith('method'),
      ),
    );
  });
}

function receiverDispatched(source: string): boolean {
  return inModule(source, (file) => {
    const method = find(file, isFunctionExpression);
    return framedReceiverDispatch(method, (name) => name.text === 'holder');
  });
}

function usesKnown(source: string): boolean {
  return inModule(source, (file) => knownUsesOnly(declared(file, 'values'), 'array'));
}

function sortsByDefault(source: string): boolean {
  return inModule(source, (file) => {
    const call = find(
      file,
      (node): node is CallExpression => isCallExpression(node) && node.getText() === 'same.sort()',
    );
    const receiver = lastNamed(file, 'same');
    return defaultArrayComparison(receiver, call, []);
  });
}

function wordsWritten(source: string): boolean {
  return inModule(source, (file) => {
    return writtenArrayWords(lastNamed(file, 'words'), {
      created: () => false,
      custom: () => false,
    });
  });
}

function settersFollowed(source: string): boolean {
  return inModule(source, (file) => {
    const object = find(file, (node): node is ObjectLiteralExpression =>
      isObjectLiteralExpression(node),
    );
    const getter = find(file, (node): node is GetAccessorDeclaration =>
      isGetAccessorDeclaration(node),
    );
    return accessorWrites(object, getter) !== undefined;
  });
}

function callbackHandsArray(source: string): boolean {
  return inModule(source, (file) => {
    return handsArray(
      find(
        file,
        (node): node is CallExpression =>
          isCallExpression(node) && node.getText().startsWith('list.map'),
      ),
      'map',
    );
  });
}

function elementsWritten(source: string): boolean {
  return inModule(source, (file) => {
    const read = find(file, (node) => isElementAccessExpression(node));
    return writtenArrayElements(lastNamed(file, 'array'), read).length > 0;
  });
}

function writesUnfollowed(source: string): boolean {
  return inModule(source, (file) => {
    const read = find(file, (node) => isElementAccessExpression(node));
    return arrayWritesUnfollowed(lastNamed(file, 'array'), read);
  });
}

function declared(file: SourceFile, name: string): VariableDeclaration {
  return find(
    file,
    (node): node is VariableDeclaration =>
      isVariableDeclaration(node) && node.name.getText() === name,
  );
}

function lastNamed(file: SourceFile, name: string): Identifier {
  const found: Identifier[] = [];
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isIdentifier(node) && node.text === name) found.push(node);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  const last = found.toSorted((one, other) => other.pos - one.pos)[0];
  if (last === undefined) throw new Error(`no ${name}`);
  return last;
}

function find<T extends Node>(root: Node, matches: (node: Node) => node is T): T {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (matches(node)) return node;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no such node');
}
