import { type Expression, isCallExpression, isIdentifier, type Node } from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { unwrapped } from '../src/compiler/bounded.ts';
import { framedArrayString } from '../src/compiler/framed-arrays.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * An array that holds lists holds them themselves, not copies: a copy of it (a spread, `slice`,
 * `Array.from`, a parameter of a callback, a pattern) hands the list on, and a write through the copy
 * is a write to the list, by no name a reader follows. Such an array is followed by the uses that hand no
 * element out. An array whose elements are texts, numbers and error words is followed as before. Each
 * write below is a push of `error` into the inner list; \`String(array)\` converts it.
 */

/** The ways an inner list `inner` reaches the array `a`: held by its literal, written to it, nested a level deeper. */
const HOLDERS = {
  named: 'const inner: any[] = []; const a: any[] = [inner]; ',
  literal: 'const a: any[] = [[]]; ',
  pushed: 'const inner: any[] = []; const a: any[] = []; a.push(inner); ',
  indexed: 'const inner: any[] = []; const a: any[] = []; a[0] = inner; ',
  assigned: 'const inner: any[] = []; const a: any[] = []; Object.assign(a, { 0: inner }); ',
  'spread-literal': 'const inner: any[] = []; const a: any[] = [...[inner]]; ',
  'two-levels': 'const inner: any[] = []; const a: any[] = [[inner]]; ',
  alias: 'const inner: any[] = []; const base: any[] = [inner]; const a = base; ',
} as const;

/** How the list is handed out of the array and written; the last marks a use that writes nothing. */
const HANDS = [
  ['slice', 'a.slice()[0].push(error);', 'write'],
  ['concat', 'a.concat()[0].push(error);', 'write'],
  ['flat', 'a.flat(0)[0].push(error);', 'write'],
  ['flat-map', 'a.flatMap((x: any) => [x])[0].push(error);', 'write'],
  ['filter', 'a.filter(() => true)[0].push(error);', 'write'],
  ['map', 'a.map((x: any) => x)[0].push(error);', 'write'],
  ['from', 'Array.from(a)[0].push(error);', 'write'],
  ['from-map', 'Array.from(a, (x: any) => x)[0].push(error);', 'write'],
  ['spread', '[...a][0].push(error);', 'write'],
  ['spread-call', '((...r: any[]) => r[0].push(error))(...a);', 'write'],
  ['values', 'Object.values(a)[0].push(error);', 'write'],
  ['entries', 'Object.entries(a)[0][1].push(error);', 'write'],
  ['for-of', 'for (const x of a) { x.push(error); }', 'write'],
  ['for-each', 'a.forEach((x: any) => { x.push(error); });', 'write'],
  ['pattern', 'const [x]: any = a; x.push(error);', 'write'],
  ['pattern-index', 'const { 0: x }: any = a; x.push(error);', 'write'],
  ['pattern-assign', 'let x: any; [x] = a; x.push(error);', 'write'],
  ['iterator-values', 'a.values().next().value.push(error);', 'write'],
  ['iterator-entries', 'a.entries().next().value[1].push(error);', 'write'],
  ['at', 'a.at(0).push(error);', 'write'],
  ['find', 'a.find(() => true).push(error);', 'write'],
  ['find-last', 'a.findLast(() => true).push(error);', 'write'],
  ['index', 'a[0].push(error);', 'write'],
  ['index-alias', 'const e = a[0]; e.push(error);', 'write'],
  ['descriptor', '(Object.getOwnPropertyDescriptor(a, 0) as any).value.push(error);', 'write'],
  ['descriptors', '(Object.getOwnPropertyDescriptors(a) as any)[0].value.push(error);', 'write'],
  ['reduce', 'a.reduce((acc: any, x: any) => { x.push(error); return acc; }, 0);', 'write'],
  ['some', 'a.some((x: any) => { x.push(error); return false; });', 'write'],
  ['every', 'a.every((x: any) => { x.push(error); return true; });', 'write'],
  ['find-index', 'a.findIndex((x: any) => { x.push(error); return false; });', 'write'],
  ['to-sorted', 'a.toSorted()[0].push(error);', 'write'],
  ['to-reversed', 'a.toReversed()[0].push(error);', 'write'],
  ['with', 'a.with(0, a[0])[0].push(error);', 'write'],
  ['to-spliced', 'a.toSpliced(1, 0)[0].push(error);', 'write'],
  ['splice', 'a.splice(0, 1)[0].push(error);', 'stays'],
  ['sort-chain', 'a.sort()[0].push(error);', 'write'],
  ['reverse-chain', 'a.reverse()[0].push(error);', 'write'],
  ['borrowed-slice', 'Array.prototype.slice.call(a)[0].push(error);', 'write'],
  ['borrowed-map', 'Array.prototype.map.call(a, (x: any) => x)[0].push(error);', 'write'],
  ['assign-source', 'Object.assign({}, a)[0].push(error);', 'write'],
  ['assign-array-target', 'Object.assign([], a)[0].push(error);', 'write'],
  ['new-set', '[...new Set(a)][0].push(error);', 'write'],
  ['from-entries', 'Object.fromEntries(Object.entries(a))[0].push(error);', 'write'],
  ['json-clone-pin', 'JSON.parse(JSON.stringify(a))[0].push(error);', 'pin'],
  ['structured-clone-pin', 'structuredClone(a)[0].push(error);', 'stays'],
  ['length-pin', 'void a.length;', 'pin'],
  ['join-pin', "void a.join(',');", 'pin'],
  ['slice-length-pin', 'void a.slice().length;', 'stays'],
  ['spread-length-pin', 'void [...a].length;', 'stays'],
  ['for-each-read-pin', 'a.forEach((x: any) => { void x; });', 'stays'],
  ['index-read-pin', 'void a[0];', 'pin'],
] as const;

/** A name a pattern takes apart from a literal written beside it, with the list it selects. */
const PATTERNS = [
  ['array-push', 'const [item]: any = [[] as any[]]; item.push(error); return String(item);', true],
  [
    'object-push',
    'const { item }: any = { item: [] as any[] }; item.push(error); return String(item);',
    true,
  ],
  ['array-index', 'const [item]: any = [[] as any[]]; item[0] = error; return String(item);', true],
  ['array-error', 'const [item]: any = [[error]]; return String(item);', true],
  ['object-error', 'const { item }: any = { item: [error] }; return String(item);', true],
  ['nested', 'const [[item]]: any = [[[] as any[]]]; item.push(error); return String(item);', true],
  [
    'rest',
    "const [, ...rest]: any = ['x', [] as any[]]; rest[0].push(error); return String(rest);",
    true,
  ],
  ['default', 'const [item = []]: any = []; item.push(error); return String(item);', true],
  [
    'outer-literal',
    'const [item]: any = [[] as any[]]; const a: any[] = [item]; item.push(error); return String(a);',
    true,
  ],
  [
    'outer-array',
    'const [item]: any = [[] as any[]]; item.push(error); return String([item]);',
    true,
  ],
  [
    'via-const',
    'const src: any[] = [[] as any[]]; const [item]: any = src; src[0].push(error); return String(item);',
    true,
  ],
  ['scalar-pin', "const [item]: any = ['safe']; return String(item);", false],
  ['object-scalar-pin', "const { item }: any = { item: 'safe' }; return String(item);", false],
  ['parameter-pin', 'const [item]: any = other; return String(item);', false],
  [
    'scalar-beside-an-array-pin',
    "const [item, rest]: any = ['safe', [] as any[]]; void rest; return String(item);",
    false,
  ],
] as const;

/** Arrays of texts, typed names and error words stay followed as before; one of unknown elements hands them out. */
const ELEMENTS = [
  [
    'texts copied are no list',
    "const a: any[] = ['safe', 'text']; [...a]; a.slice(); a.forEach((x: any) => { void x; }); return String(a);",
    false,
  ],
  [
    'typed names copied are no list',
    "const a: any[] = [name, 'text']; [...a]; Array.from(a); return String(a);",
    false,
  ],
  [
    'numbers and booleans copied are no list',
    'const a: any[] = [1, true, -2]; const b = [...a]; void b; return String(a);',
    false,
  ],
  [
    'a text written after is no list',
    "const a: any[] = ['safe']; a.push('more'); [...a]; return String(a);",
    false,
  ],
  [
    'an element of unknown type is a list that is handed out',
    'const a: any[] = [other]; [...a]; return String(a);',
    true,
  ],
  [
    'an unknown element written after is a list that is handed out',
    "const a: any[] = ['safe']; a.push(other); [...a]; return String(a);",
    true,
  ],
  [
    'a list written by an index is handed out',
    "const a: any[] = ['safe']; a[1] = [] as any[]; [...a]; return String(a);",
    true,
  ],
  [
    'a list a spread brings is handed out',
    'const a: any[] = [...[[] as any[]]]; [...a]; return String(a);',
    true,
  ],
  [
    'an unknown list spread in is handed out',
    'const a: any[] = [...other]; [...a]; return String(a);',
    true,
  ],
  [
    'an element that is a choice of a list is handed out',
    "const a: any[] = [name ? [] as any[] : 'safe']; [...a]; return String(a);",
    true,
  ],
  [
    'an element kept by a name of a list is handed out',
    'const inner: any[] = []; const a: any[] = [inner]; [...a]; return String(a);',
    true,
  ],
  [
    'an element that is a text by its name is no list',
    "const text = 'safe'; const a: any[] = [text]; [...a]; return String(a);",
    false,
  ],
  [
    'a member read of unknown type is a list that is handed out',
    'const a: any[] = [error.length as number]; [...a]; return String(a);',
    true,
  ],
  [
    'a name given a list after a text is a list that is handed out',
    "const inner: any[] = []; let v: any = 'safe'; v = inner; const a: any[] = [v]; a.forEach((x: any) => { x.push(error); }); return String(a);",
    true,
  ],
  [
    'a name typed as a union and given a list is a list that is handed out',
    "const inner: any[] = []; let v: string | any[] = 'safe'; v = inner; const a: any[] = [v]; a.forEach((x: any) => { x.push(error); }); return String(a);",
    true,
  ],
  [
    'a parameter with a default is a list that is handed out',
    "function pass(v: any = 'x') { const a: any[] = [v]; a.forEach((x: any) => { x.push(error); }); return String(a); } return pass([]);",
    true,
  ],
  [
    'a name given a text again stays a list that is handed out',
    "let v: any = 'safe'; v = 'other'; const a: any[] = [v]; [...a]; return String(a);",
    true,
  ],
  [
    'a name given a number by an arithmetic assignment stays a list that is handed out',
    'let n: any = 1; n += 2; const a: any[] = [n]; [...a]; return String(a);',
    true,
  ],
  [
    'a name never written after its text is no list',
    "let v: any = 'safe'; const a: any[] = [v]; [...a]; return String(a);",
    false,
  ],
] as const;

describe('an array that holds a list, handed out', () => {
  describe.each(Object.entries(HOLDERS))('holder %s', (holder, setup) => {
    it.each(HANDS)('%s', (_hand, body, kind) => {
      const inner =
        holder === 'two-levels' ? body.replaceAll('.push(error)', '[0].push(error)') : body;

      expect(convertsError(`${setup}${inner} return String(a);`)).toBe(kind !== 'pin');
    });
  });
});

describe('a name a pattern takes apart from a written literal', () => {
  it.each(PATTERNS)('%s', (_name, body, converts) => {
    expect(convertsError(body)).toBe(converts);
  });
});

describe('the elements of an array decide whether it hands lists out', () => {
  it.each(ELEMENTS)('%s', (_name, body, converts) => {
    expect(convertsError(body)).toBe(converts);
  });
});

/** Whether the source's `String(array)` converts the `error` it holds, given a function that declares its names. */
function convertsError(body: string): boolean {
  using api = openTypeScript();
  using parsed = parseModule(
    api,
    'nested-lists.ts',
    `function frames(error: Error, name: string, other: any) { ${body} }`,
  );
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
