import {
  isCallExpression,
  isExpressionStatement,
  type Expression,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { framedObjectSources } from '../src/compiler/framed-object-members.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A setter the assign target's prototype holds is called with the value copied under its own key,
 * and may store it under another: an opaque source copied after the prototype is a possible value
 * of any field through each key a setter of a literal prototype answers. Where a prototype or a
 * setter's key cannot be read, no key is known, and the source keeps its member of the read key.
 */
const SETTER = '{ set input(value: Error) { (this as { output?: Error }).output = value; } }';

const CASES = [
  {
    id: 'reviewed-opaque-later-source',
    source: `Object.assign({}, { ['__proto__']: ${SETTER} }, src)`,
    sources: ['src:input', 'src:output'],
  },
  {
    id: 'spread-in-later-source',
    source: `Object.assign({}, { ['__proto__']: ${SETTER} }, { ...src })`,
    sources: ['src:__proto__.output', 'src:input', 'src:output'],
  },
  {
    id: 'spread-after-prototype-in-one-source',
    source: `Object.assign({}, { ['__proto__']: ${SETTER}, ...src })`,
    sources: ['src:__proto__.output', 'src:input', 'src:output'],
  },
  {
    id: 'setter-of-the-prototype-of-the-prototype',
    source: `Object.assign({}, { ['__proto__']: { __proto__: ${SETTER} } }, src)`,
    sources: ['src:input', 'src:output'],
  },
  {
    id: 'computed-setter-key',
    source: `Object.assign({}, { ['__proto__']: { set ['input'](value: Error) {} } }, src)`,
    sources: ['src:input', 'src:output'],
  },
  {
    id: 'two-setters',
    source: `Object.assign({}, { ['__proto__']: { set first(value: Error) {}, set second(value: Error) {} } }, src)`,
    sources: ['src:first', 'src:output', 'src:second'],
  },
  {
    id: 'unread-setter-key-keeps-read-key',
    source: `Object.assign({}, { ['__proto__']: { set [name](value: Error) {} } }, src)`,
    sources: ['src:output'],
  },
  {
    id: 'unread-prototype-keeps-read-key',
    source: "Object.assign({}, { ['__proto__']: made }, src)",
    sources: ['made:output', 'src:output'],
  },
  {
    id: 'no-setter-prototype-pin',
    source: "Object.assign({}, { ['__proto__']: { other: 1 } }, src)",
    sources: ['src:output'],
  },
  {
    id: 'source-before-prototype-pin',
    source: `Object.assign({}, src, { ['__proto__']: ${SETTER} })`,
    sources: ['src:output'],
  },
] as const;

describe('opaque sources copied after an assigned prototype that holds a setter', () => {
  it.each(CASES)('$id', ({ source, sources }) => {
    expect(selected(source)).toStrictEqual([...sources].toSorted(compare));
  });
});

/** The sources field `output` of the assignment may be read from, in text order. */
function selected(source: string): readonly string[] | undefined {
  using api = openTypeScript();
  using parsed = parseModule(
    api,
    'assign-opaque-sources.ts',
    `declare const src: { input: Error }; declare const made: object; declare const name: string; ${source};`,
  );
  return framedObjectSources(statement(parsed.sourceFile), ['output'])
    ?.map((each) => `${each.value.getText()}:${each.keys.join('.')}`)
    .toSorted(compare);
}

function compare(left: string, right: string): number {
  return left.localeCompare(right);
}

function statement(root: Node): Expression {
  const pending = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isExpressionStatement(node) && isCallExpression(node.expression)) return node.expression;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  throw new Error('no assignment');
}
