import { afterEach, describe, expect, it } from 'vitest';

import { cleanUp, read } from './support/hook-callers.ts';

/**
 * A hook returns its setters, and the functions that write, item by item, which its callers hold to
 * the handlers of events: a setter is called from one, or handed on as React's own, and from nothing
 * React calls as it renders. A setter the hook keeps under another name — `const reset =
 * setCount` — and returns is the setter, for its callers: they hold the name to the same.
 */

const HEAD = "import { useReactiveState } from 'framework/react';\n";

/** A hook of a state a parameter feeds (`fed`) or that it starts itself, with `body` ahead of its return. */
function hookOf(body: string, ret: string, started = 'useReactiveState(start)'): string {
  return `${HEAD}
export function useLab(start: number) {
  const [count, setCount] = ${started};
${body}
  return ${ret};
}
`;
}

/** The setter of the hook's state kept under another name. */
const KEPT = '  const reset = setCount;';

const CALLED = 'The setter is called from the handler of an event a person';
const GIVEN = 'writes a state, and given to a call as the JSX is built';
const COMMITTED = 'writes a state, and React calls what `ref` is given itself';

describe.each([
  { name: 'a state a parameter feeds', started: 'useReactiveState(start)' },
  { name: 'a state the hook starts itself', started: 'useReactiveState(0)' },
])('a hook of $name', ({ started }) => {
  afterEach(cleanUp);

  it.each([
    {
      id: 'called as the JSX is built, by an object item',
      ret: '{ count, reset }',
      use: 'const { count, reset } = useLab(1);\nreturn <p>{count}{reset(0)}</p>;',
      refused: CALLED,
    },
    {
      id: 'called as the JSX is built, by an array item',
      ret: '[count, reset] as const',
      use: 'const [count, reset] = useLab(1);\nreturn <p>{count}{reset(0)}</p>;',
      refused: CALLED,
    },
    {
      id: 'a callback ref',
      ret: '{ count, reset }',
      use: 'const { count, reset } = useLab(1);\nreturn <p ref={reset}>{count}</p>;',
      refused: COMMITTED,
    },
    {
      id: 'handed to a call as the JSX is built',
      ret: '{ count, reset }',
      use: 'const { count, reset } = useLab(1);\nreturn <p>{count}{[1].map(reset)}</p>;',
      refused: GIVEN,
    },
    {
      id: 'kept under a name by a cast',
      ret: '{ count, reset }',
      body: '  const reset = setCount as (n: number) => void;',
      use: 'const { count, reset } = useLab(1);\nreturn <p>{count}{reset(0)}</p>;',
      refused: CALLED,
    },
  ])('refuses a setter kept under another name, $id', ({ body = KEPT, ret, use, refused }) => {
    expect(read(hookOf(body, ret, started), use)).toContain(refused);
  });

  it.each([
    {
      id: 'an event handler',
      use: 'const { count, reset } = useLab(1);\nreturn <button onClick={() => reset(0)}>{count}</button>;',
    },
    {
      id: 'handed on as React’s own',
      use: 'const { count, reset } = useLab(1);\nreturn <input value={count} onChange={() => reset(1)} />;',
    },
    {
      id: 'read as a value',
      use: 'const { count } = useLab(1);\nreturn <p>{count}</p>;',
    },
  ])('takes it where it is called from a handler: $id', ({ use }) => {
    expect(read(hookOf('  const reset = setCount;', '{ count, reset }', started), use)).toBe(
      'taken',
    );
  });

  it.each([
    {
      id: 'a function that calls the setter',
      body: '  const reset = () => {\n    setCount(0);\n  };',
      ret: '{ count, reset }',
    },
    { id: 'the setter itself', body: '', ret: '{ count, reset: setCount }' },
  ])('still refuses what it did: $id', ({ body, ret }) => {
    expect(
      read(
        hookOf(body, ret, started),
        'const { count, reset } = useLab(1);\nreturn <p>{count}{reset(0)}</p>;',
      ),
    ).toContain('from the handler of an event a person');
  });

  it.each([
    { id: 'an object pattern', body: '  const { length: arity } = setCount;' },
    { id: 'an array pattern', body: '  const [arity] = setCount as unknown as number[];' },
  ])('takes what a pattern binds of the setter, which is no setter: $id', ({ body }) => {
    expect(
      read(
        hookOf(body, '{ count, arity }', started),
        'const { count, arity } = useLab(1);\nreturn <p>{count}{Math.max(arity, 1)}</p>;',
      ),
    ).toBe('taken');
  });

  it.each([
    {
      id: 'two names',
      body: '  const first = setCount;\n  const reset = first;',
    },
    {
      id: 'three names, through a cast and a parenthesis',
      body: '  const first = setCount;\n  const second = first as (n: number) => void;\n  const reset = (second);',
    },
    {
      id: 'twelve names',
      body: [
        '  const n0 = setCount;',
        ...Array.from({ length: 11 }, (_, at) => `  const n${at + 1} = n${at};`),
        '  const reset = n11;',
      ].join('\n'),
    },
  ])('refuses a setter kept under a chain of names: $id', ({ body }) => {
    expect(
      read(
        hookOf(body, '{ count, reset }', started),
        'const { count, reset } = useLab(1);\nreturn <p>{count}{reset(0)}</p>;',
      ),
    ).toContain(CALLED);
  });

  it.each([
    {
      id: 'a chain of names of a value',
      body: '  const first = count;\n  const shown = first;',
      name: 'shown',
    },
    {
      id: 'a chain that turns back on itself',
      body: '  const first = second;\n  const second = first;',
      name: 'first',
    },
    {
      id: 'a chain that ends in a pattern',
      body: '  const { length: arity } = setCount;\n  const shown = arity;',
      name: 'shown',
    },
  ])('takes what no chain of names ends at a setter: $id', ({ body, name }) => {
    const use = [
      'const { count, ',
      name,
      ' } = useLab(1);\nreturn <p>{count}{String(',
      name,
      ')}</p>;',
    ].join('');

    expect(read(hookOf(body, `{ count, ${name} }`, started), use)).toBe('taken');
  });

  it('takes an alias of what is no setter', () => {
    expect(
      read(
        hookOf('  const shown = count;', '{ count, shown }', started),
        'const { count, shown } = useLab(1);\nreturn <p>{count}{shown}</p>;',
      ),
    ).toBe('taken');
  });
});

describe('a hook with an alias of its setter, bound whole', () => {
  afterEach(cleanUp);

  const whole = 'const lab = useLab(1);\nreturn <p>{lab.count}</p>;';

  it('is refused where a parameter feeds its state, as it was', () => {
    expect(read(hookOf('  const reset = setCount;', '{ count, reset }'), whole)).toContain(
      'named item by item',
    );
  });

  it('is taken where it starts the state itself, as it was', () => {
    expect(
      read(hookOf('  const reset = setCount;', '{ count, reset }', 'useReactiveState(0)'), whole),
    ).toBe('taken');
  });
});
