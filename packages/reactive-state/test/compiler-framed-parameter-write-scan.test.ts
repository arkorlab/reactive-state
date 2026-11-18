import {
  type FunctionDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isParameterDeclaration,
  isReturnStatement,
  type Node,
  type ParameterDeclaration,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedParameterWrites } from '../src/compiler/framed-parameter-writes.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * What a function's own code writes into a parameter is read from its whole code, its parameters'
 * initializers and patterns included, and a default inside a pattern that assigns the parameter is a
 * write of whatever the pattern's source gives it: the default runs only where that source is
 * `undefined`. A plain assignment, wherever an expression may stand (an element of a list, a member
 * of a literal, an argument), is still one value the parameter may take.
 */
const FUNCTION = 'function frames(target: unknown, key: string, extra?: unknown) {';

const UNKNOWN = [
  {
    id: 'array-pattern-default',
    source: `${FUNCTION} [target = {}] = [new Error()]; return target; }`,
  },
  {
    id: 'array-pattern-default-after-a-hole',
    source: `${FUNCTION} [, target = {}] = [0, new Error()]; return target; }`,
  },
  {
    id: 'array-pattern-default-beside-others',
    source: `${FUNCTION} [key, target = {}] = ['a', new Error()]; return target; }`,
  },
  {
    id: 'array-pattern-default-in-a-rest',
    source: `${FUNCTION} [...[target = {}]] = [new Error()]; return target; }`,
  },
  {
    id: 'object-pattern-default-of-a-member',
    source: `${FUNCTION} ({ cause: target = {} } = { cause: new Error() }); return target; }`,
  },
  {
    id: 'object-pattern-default-of-a-computed-member',
    source: `${FUNCTION} ({ ['cause']: target = {} } = { cause: new Error() }); return target; }`,
  },
  {
    id: 'nested-array-pattern-default',
    source: `${FUNCTION} [[target = {}]] = [[new Error()]]; return target; }`,
  },
  {
    id: 'nested-pattern-default-of-a-member',
    source: `${FUNCTION} [{ cause: target = {} }] = [{ cause: new Error() }]; return target; }`,
  },
  {
    id: 'default-of-a-nested-pattern-with-a-default',
    source: `${FUNCTION} [[target = {}] = []] = [[new Error()]]; return target; }`,
  },
  {
    id: 'array-pattern-default-of-a-loop-head',
    source: `${FUNCTION} for ([target = {}] of [[new Error()]]) { void key; } return target; }`,
  },
  {
    id: 'object-pattern-default-of-a-loop-head',
    source: `${FUNCTION} for ({ cause: target = {} } of [{ cause: new Error() }]) { void key; } return target; }`,
  },
  {
    id: 'array-pattern-default-in-a-closure',
    source: `${FUNCTION} const set = () => { [target = {}] = [new Error()]; }; set(); return target; }`,
  },
  {
    id: 'parenthesized-array-pattern-default',
    source: `${FUNCTION} [(target) = {}] = [new Error()]; return target; }`,
  },
  {
    id: 'shorthand-pattern-default-pin',
    source: `${FUNCTION} ({ target = {} } = { target: new Error() }); return target; }`,
  },
  {
    id: 'plain-pattern-pin',
    source: `${FUNCTION} [target] = [new Error()]; return target; }`,
  },
  {
    id: 'compound-write-in-a-default',
    source: 'function frames(target: number, extra = (target += 1)) { return target; }',
  },
  {
    id: 'increment-in-a-default',
    source: 'function frames(target: number, extra = target++) { return target; }',
  },
  {
    id: 'pattern-in-a-default',
    source:
      'function frames(target: unknown, extra = ([target] = [new Error()])) { return target; }',
  },
  {
    id: 'pattern-default-in-a-default',
    source:
      'function frames(target: unknown, extra = ([target = {}] = [new Error()])) { return target; }',
  },
] as const;

const VALUES = [
  {
    id: 'plain-assignment-pin',
    source: `${FUNCTION} target = new Error(); return target; }`,
    values: ['new Error()'],
    definite: true,
  },
  {
    id: 'assignment-in-a-list-pin',
    source: `${FUNCTION} const list = [target = new Error()]; void list; return target; }`,
    values: ['new Error()'],
    definite: false,
  },
  {
    id: 'assignment-in-a-literal-member-pin',
    source: `${FUNCTION} const holder = { cause: target = new Error() }; void holder; return target; }`,
    values: ['new Error()'],
    definite: false,
  },
  {
    id: 'assignment-in-an-argument-pin',
    source: `${FUNCTION} void [target = new Error()].length; return target; }`,
    values: ['new Error()'],
    definite: false,
  },
  {
    id: 'assignment-of-a-list-pin',
    source: `${FUNCTION} target = [new Error()]; return target; }`,
    values: ['[new Error()]'],
    definite: true,
  },
  {
    id: 'pattern-default-of-another-name-pin',
    source: `${FUNCTION} [key = 'a'] = ['b']; return target; }`,
    values: [],
    definite: false,
  },
  {
    id: 'pattern-default-reading-the-parameter-pin',
    source: `${FUNCTION} const [first = target] = [undefined]; void first; return target; }`,
    values: [],
    definite: false,
  },
  {
    id: 'default-of-another-parameter',
    source: 'function frames(target: unknown, extra = (target = new Error())) { return target; }',
    values: ['new Error()'],
    definite: false,
  },
  {
    id: 'default-of-another-parameter-in-parentheses-twice',
    source: 'function frames(target: unknown, extra = ((target = new Error()))) { return target; }',
    values: ['new Error()'],
    definite: false,
  },
  {
    id: 'default-of-a-later-pattern-parameter',
    source:
      'function frames(target: unknown, { cause = (target = new Error()) }: { cause?: unknown } = {}) { return target; }',
    values: ['new Error()'],
    definite: false,
  },
  {
    id: 'default-in-the-computed-key-of-a-parameter-pattern',
    source:
      "function frames(target: unknown, { [(target = new Error(), 'cause')]: cause }: { cause?: unknown } = {}) { return target; }",
    values: ['new Error()'],
    definite: false,
  },
  {
    id: 'default-of-another-parameter-beside-a-body-write',
    source:
      'function frames(target: unknown, extra = (target = new Error())) { target = 1; return target; }',
    values: ['new Error()', '1'],
    definite: false,
  },
  {
    id: 'default-of-the-parameter-itself',
    source: 'function frames(target: unknown = (target = new Error())) { return target; }',
    values: ['new Error()'],
    definite: false,
  },
  {
    id: 'default-reading-the-parameter-pin',
    source: 'function frames(target: unknown, extra = target) { return extra; }',
    values: [],
    definite: false,
  },
  {
    id: 'default-writing-another-parameter-pin',
    source:
      'function frames(target: unknown, key = String(target), extra = (key = "k")) { return target; }',
    values: [],
    definite: false,
  },
  {
    id: 'default-without-a-write-pin',
    source: 'function frames(target: unknown, extra = new Error()) { return target; }',
    values: [],
    definite: false,
  },
  {
    id: 'body-write-pin',
    source: 'function frames(target: unknown, extra = 1) { target = new Error(); return target; }',
    values: ['new Error()'],
    definite: true,
  },
] as const;

/** The function `frames` of the source, its parameter `target` and the `target` it returns. */
function frameOf(root: Node): {
  readonly fn: FunctionDeclaration;
  readonly parameter: ParameterDeclaration;
  readonly point: Node;
} {
  const pending = [root];
  let fn: FunctionDeclaration | undefined;
  let point: Node | undefined;
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isFunctionDeclaration(node) && node.name?.text === 'frames') fn = node;
    if (isReturnStatement(node) && node.expression !== undefined && isIdentifier(node.expression))
      point = node.expression;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  const parameter = fn?.parameters.find(
    (each): each is ParameterDeclaration =>
      isParameterDeclaration(each) && each.name.getText() === 'target',
  );
  if (fn === undefined || parameter === undefined || point === undefined)
    throw new Error('no frame');
  return { fn, parameter, point };
}

describe('the writes of a parameter in the code of its function', () => {
  it.each(UNKNOWN)('may write what the code does not show: $id', ({ source }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'x.ts', source);
    const { fn, parameter, point } = frameOf(parsed.sourceFile);

    expect(framedParameterWrites(fn, parameter, point).unknown).toBe(true);
  });

  it.each(VALUES)('writes the values it shows: $id', ({ source, values, definite }) => {
    using api = openTypeScript();
    using parsed = parseModule(api, 'x.ts', source);
    const { fn, parameter, point } = frameOf(parsed.sourceFile);

    const writes = framedParameterWrites(fn, parameter, point);
    const texts = writes.values.map((each) => each.getText());

    expect(writes.unknown).toBe(false);
    expect(texts.toSorted((a, b) => a.localeCompare(b))).toStrictEqual(
      [...values].toSorted((a, b) => a.localeCompare(b)),
    );
    expect(writes.definite !== undefined).toBe(definite);
  });
});
