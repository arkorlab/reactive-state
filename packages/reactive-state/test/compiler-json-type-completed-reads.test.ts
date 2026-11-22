import {
  isFunctionDeclaration,
  isTypeAliasDeclaration,
  type TypeNode,
  type TypeParameterDeclaration,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { nonJsonPart } from '../src/compiler/json-types.ts';
import { Modules } from '../src/compiler/modules.ts';
import { typeReading } from '../src/compiler/type-names.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * What a state's type admits that no JSON holds (`nonJsonPart`), where one type is reused by several
 * members of another: `type Pair = { left: Leaf; right: Leaf }`. A type walked to the end with
 * nothing found is not walked again, so the work grows with the source — one read of each
 * declaration, as an object's entry and as an array's element — and not with the number of paths
 * through it, which multiplies by the references a level holds at every level. A part found ends the
 * whole walk, and a declaration read as an array's element is read again where it was read as an
 * entry, which leaves `undefined` out.
 *
 * The work is counted as the references the walk reads: it asks the type parameters of the
 * function the types are written for (`TypeReading.parameters`) whether each one names one of them,
 * and the list it is given counts the questions and stops the walk past a budget, so that a walk
 * that grows with the paths fails here at once instead of running for hours.
 */

/** References a walk may read: a tower of twenty levels read by its paths takes a million. */
const BUDGET = 10_000;

const api = openTypeScript();

/** What a walk of `type` answered, and the references it read. */
interface Walked {
  readonly admits: string | undefined;
  readonly part: string | undefined;
  readonly references: number;
}

/** The list of type parameters a walk is given: empty, counting the references it is asked about. */
function counted(): { readonly list: TypeParameterDeclaration[]; readonly count: () => number } {
  const list: TypeParameterDeclaration[] = [];
  let references = 0;
  Object.defineProperty(list, 'find', {
    value: (): undefined => {
      references += 1;
      if (references > BUDGET) {
        throw new Error(`the walk read more than ${BUDGET} references`);
      }
    },
  });
  return { count: () => references, list };
}

/** The walk of the alias `State` that `source` declares. */
function walkedState(source: string): Walked {
  using parsed = parseModule(api, 'state.ts', source);
  using modules = new Modules(api, process.cwd());
  const { sourceFile } = parsed;
  const state = sourceFile.statements.find(
    (statement) => isTypeAliasDeclaration(statement) && statement.name.text === 'State',
  );
  if (state === undefined || !isTypeAliasDeclaration(state)) {
    throw new Error('no State');
  }
  const { count, list } = counted();
  const reading = typeReading(modules, { declarations: list, file: 'state.ts' });
  const found = nonJsonPart(state.type, { file: 'state.ts', sourceFile }, reading);
  return { admits: found?.admits, part: found?.part, references: count() };
}

/** The walk of the type of the first parameter of the function `use`, its type parameters given. */
function walkedParameter(source: string): Walked {
  using parsed = parseModule(api, 'state.ts', source);
  using modules = new Modules(api, process.cwd());
  const { sourceFile } = parsed;
  const use = sourceFile.statements.find(
    (statement) => isFunctionDeclaration(statement) && statement.name?.text === 'use',
  );
  const type: TypeNode | undefined =
    use !== undefined && isFunctionDeclaration(use) ? use.parameters[0]?.type : undefined;
  if (type === undefined || use === undefined || !isFunctionDeclaration(use)) {
    throw new Error('no use');
  }
  const reading = typeReading(modules, {
    declarations: use.typeParameters ?? [],
    file: 'state.ts',
  });
  const found = nonJsonPart(type, { file: 'state.ts', sourceFile }, reading);
  return { admits: found?.admits, part: found?.part, references: 0 };
}

/** What a member of `T(k-1)` is, as the `index`th of a level: itself, in a list, or as `Partial`. */
type Member = (previous: string, index: number) => string;

const PLAIN: Member = (previous) => previous;
const LISTED: Member = (previous, index) => (index % 2 === 0 ? previous : `${previous}[]`);
const PARTIAL: Member = (previous) => `Partial<${previous}>`;

/** `T0`, then `Tk` of `refs` members of `T(k-1)` up to `depth`, and `State` of the last. */
function tower(depth: number, refs: number, member: Member, form: 'alias' | 'interface'): string {
  const declare = (name: string, body: string): string =>
    form === 'alias' ? `type ${name} = ${body};` : `interface ${name} ${body}`;
  const lines = [declare('T0', '{ id: string }')];
  for (let level = 1; level <= depth; level += 1) {
    const previous = `T${level - 1}`;
    const members = Array.from(
      { length: refs },
      (_, index) => `m${index}: ${member(previous, index)}`,
    );
    lines.push(declare(`T${level}`, `{ ${members.join('; ')} }`));
  }
  lines.push(`type State = T${depth};`);
  return lines.join('\n');
}

/**
 * A domain model of `levels` levels of `width` types, each of `refs` types of the level below —
 * `(i + j) % width`, so every type is named by `refs` others, and the leaves are shared — beside
 * plain members, and `State` of the top level's types.
 */
function domain(levels: number, width: number, refs: number): { source: string; named: number } {
  const lines: string[] = [];
  let named = 0;
  for (let level = 0; level < levels; level += 1) {
    for (let index = 0; index < width; index += 1) {
      const members = ['id: string', 'createdAt: string', 'count: number', 'label: string | null'];
      const below = level === 0 ? 0 : refs;
      for (let each = 0; each < below; each += 1) {
        members.push(`m${each}: L${level - 1}T${(index + each) % width}`);
        named += 1;
      }
      lines.push(
        level % 2 === 0
          ? `interface L${level}T${index} { ${members.join('; ')} }`
          : `type L${level}T${index} = { ${members.join('; ')} };`,
      );
    }
  }
  const top = Array.from({ length: width }, (_, index) => `t${index}: L${levels - 1}T${index}`);
  lines.push(`type State = { ${top.join('; ')} };`);
  return { named: named + width, source: lines.join('\n') };
}

const ELEMENT = "among an array's elements";

/** Whether the walk found `undefined` among an array's elements. */
function told({ admits }: Walked): boolean {
  return admits?.includes(ELEMENT) === true;
}

interface Case {
  readonly id: string;
  readonly source: string;
  /** The part found, as the code writes it; none where the type is JSON all through. */
  readonly part: string | undefined;
  /** Whether it is told as `undefined` among an array's elements. */
  readonly element?: boolean;
  /** The most references the walk may read. */
  readonly references?: number;
}

const DOMAIN = domain(7, 6, 4);

const WORK: readonly Case[] = [
  {
    id: 'tower-two-references-a-level-twenty-deep',
    source: tower(20, 2, PLAIN, 'alias'),
    part: undefined,
    references: 2 * 20 + 1,
  },
  {
    id: 'tower-three-references-a-level-eighteen-deep',
    source: tower(18, 3, PLAIN, 'alias'),
    part: undefined,
    references: 3 * 18 + 1,
  },
  {
    id: 'tower-of-interfaces-three-references-a-level-eighteen-deep',
    source: tower(18, 3, PLAIN, 'interface'),
    part: undefined,
    references: 3 * 18 + 1,
  },
  {
    id: 'tower-of-lists-and-entries-each-read-in-both-ways',
    source: tower(18, 3, LISTED, 'alias'),
    part: undefined,
    references: 2 * (3 * 18 + 1),
  },
  {
    id: 'tower-of-partial-three-references-a-level-eighteen-deep',
    source: tower(18, 3, PARTIAL, 'alias'),
    part: undefined,
    // `Partial<T>` reads the members of `T`, which the three members of the level above read as well.
    references: 3 * 3 * 18 + 3 + 1,
  },
  {
    id: 'domain-model-of-seven-levels-of-six-types-four-references-each',
    source: DOMAIN.source,
    part: undefined,
    references: DOMAIN.named + 1,
  },
];

describe('the work of a walk through a type that members reuse', () => {
  it.each(WORK)('$id', ({ part, references, source }) => {
    const walk = walkedState(source);

    expect(walk.part).toBe(part);
    expect(walk.references).toBeLessThanOrEqual(references ?? BUDGET);
  });
});

const ANSWERS: readonly Case[] = [
  {
    id: 'a-function-in-a-type-another-member-holds-after-a-reused-one',
    source:
      'type Leaf = { id: string }; type Pair = { left: Leaf; right: Leaf }; type State = { pair: Pair; other: { run: () => void } };',
    part: '() => void',
  },
  {
    id: 'a-function-of-a-reused-interface-ends-the-walk-at-the-first-read',
    source: 'interface Leaf { run: () => void } type State = { a: Leaf; b: Leaf };',
    part: '() => void',
  },
  {
    id: 'a-function-found-through-the-second-member-of-a-reused-pair',
    source:
      'type Shared = { id: string }; type Left = { shared: Shared }; type Right = { shared: Shared; run: () => void }; type State = { left: Left; right: Right };',
    part: '() => void',
  },
  {
    id: 'undefined-of-an-alias-is-an-entry-and-then-an-element',
    source:
      'type Maybe = string | undefined; type Entry = { value: Maybe }; type Listed = { items: Maybe[] }; type State = { entry: Entry; listed: Listed };',
    part: 'undefined',
    element: true,
  },
  {
    id: 'undefined-of-an-alias-is-an-element-and-then-an-entry',
    source:
      'type Maybe = string | undefined; type Entry = { value: Maybe }; type Listed = { items: Maybe[] }; type State = { listed: Listed; entry: Entry };',
    part: 'undefined',
    element: true,
  },
  {
    id: 'undefined-of-an-alias-named-as-an-entry-and-an-element-of-one-type',
    source: 'type Maybe = string | undefined; type State = { entry: Maybe; listed: Maybe[] };',
    part: 'undefined',
    element: true,
  },
  {
    id: 'undefined-of-an-alias-named-as-an-element-and-an-entry-of-one-type',
    source: 'type Maybe = string | undefined; type State = { listed: Maybe[]; entry: Maybe };',
    part: 'undefined',
    element: true,
  },
  {
    id: 'an-alias-of-an-object-is-an-entry-and-an-element-both-JSON',
    source: 'type Item = { id: string }; type State = { a: Item; b: Item[]; c: Item[][] };',
    part: undefined,
  },
  {
    id: 'an-alias-that-may-be-undefined-as-an-entry-alone-is-JSON',
    source: 'type Maybe = { id: string } | undefined; type State = { a: Maybe; b: Maybe };',
    part: undefined,
  },
  {
    id: 'a-mutual-recursion-of-reused-interfaces-is-JSON',
    source:
      'interface Account { posts: Post[] } interface Post { author: Account; comments: Comment[] } interface Comment { post: Post; author: Account } type State = Account;',
    part: undefined,
  },
  {
    id: 'a-function-in-a-mutual-recursion-of-reused-interfaces-is-found',
    source:
      'interface Account { posts: Post[] } interface Post { author: Account; comments: Comment[] } interface Comment { post: Post; author: Account; run: () => void } type State = Account;',
    part: '() => void',
  },
  {
    id: 'a-type-of-itself-in-a-list-is-JSON',
    source: 'type State = { value: string; children: State[] };',
    part: undefined,
  },
  {
    id: 'a-type-of-itself-in-JSON-values-is-JSON',
    source: 'type State = string | number | boolean | null | State[] | { [key: string]: State };',
    part: undefined,
  },
  {
    id: 'a-partial-of-a-type-of-itself-is-JSON',
    source: 'type State = { children: Partial<State>[] };',
    part: undefined,
  },
  {
    id: 'an-alias-that-may-be-undefined-met-again-as-an-element-in-its-own-recursion',
    // Read as an entry it holds `undefined` and the object that reads it as an element; the
    // element is the alias again, which the walk under way did not read as one. The walk used to
    // leave it unread and take the type.
    source:
      'type Maybe = string | undefined | { next: Next }; type Next = { items: Maybe[] }; type State = { head: Maybe };',
    part: 'undefined',
    element: true,
  },
  {
    id: 'the-same-with-the-recursion-named-again-by-a-sibling',
    source:
      'type Maybe = string | undefined | { next: Next }; type Next = { items: Maybe[] }; type State = { head: Maybe; rest: Next };',
    part: 'undefined',
    element: true,
  },
];

describe('what a walk finds through a type that members reuse', () => {
  it.each(ANSWERS)('$id', ({ element = false, part, source }) => {
    const walk = walkedState(source);

    expect({ element: told(walk), part: walk.part }).toStrictEqual({ element, part });
  });
});

const PARAMETERS: readonly Case[] = [
  {
    id: 'a-constraint-that-may-be-undefined-is-an-entry-and-then-an-element',
    source: 'declare function use<T extends string | undefined>(value: { a: T; b: T[] }): void;',
    part: 'undefined',
    element: true,
  },
  {
    id: 'a-constraint-that-may-be-undefined-is-an-element-and-then-an-entry',
    source: 'declare function use<T extends string | undefined>(value: { b: T[]; a: T }): void;',
    part: 'undefined',
    element: true,
  },
  {
    id: 'a-constraint-that-may-be-undefined-as-an-entry-alone-is-JSON',
    source: 'declare function use<T extends string | undefined>(value: { a: T; b: T }): void;',
    part: undefined,
  },
  {
    id: 'a-constraint-of-text-is-an-entry-and-an-element-both-JSON',
    source: 'declare function use<T extends string>(value: { a: T; b: T[]; c: T }): void;',
    part: undefined,
  },
  {
    id: 'a-constraint-with-a-function-ends-the-walk-at-the-first-read',
    source: 'declare function use<T extends { run: () => void }>(value: { a: T; b: T }): void;',
    part: '() => void',
  },
];

describe('what a walk finds through a type parameter that members reuse', () => {
  it.each(PARAMETERS)('$id', ({ element = false, part, source }) => {
    const walk = walkedParameter(source);

    expect({ element: told(walk), part: walk.part }).toStrictEqual({ element, part });
  });
});
