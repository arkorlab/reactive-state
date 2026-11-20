import { describe, expect, it } from 'vitest';

import { analyzeComponent } from '../src/compiler/analyze.ts';
import { failIn, ReactiveCompileError } from '../src/compiler/errors.ts';
import type { HookDefinition } from '../src/compiler/hooks.ts';
import { Collected } from '../src/compiler/reads.ts';
import { walk } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';
import { collectWrites } from '../src/compiler/updaters.ts';

/**
 * A setter is called from the handler of an event a person's action dispatches: a function given as
 * the value of `onClick`, `onChange`, `onSubmit`. A handler a condition selects — `onClick={ready ?
 * () => setCount(1) : undefined}`, `onClick={ready && (() => setCount(1))}` — is that function too:
 * the condition is read for what it answers, as a cast and a parenthesis are, and the function
 * runs only on the event. A call written where the handler goes is another thing, which runs as the
 * JSX is built.
 */

/** The custom hooks the component calls, by the name they are imported as: none. */
const HOOKS: Partial<Record<string, HookDefinition>> = {};

const HANDLER_ONLY =
  "The setter is called from the handler of an event a person's action dispatches";
const HANDED_ON = 'is called from the handler of an event a person';
const WRITES = 'writes a state, so it is called, or handed on, from the handler of an event';

/** What a compile of a component of the state `count` says of it: why it is refused, or `taken`. */
function read(
  jsx: string,
  options: { readonly before?: string | undefined; readonly local?: boolean } = {},
): string {
  const source = [
    "import { useReactiveState } from 'framework/react';",
    "import { Checkbox } from '@/ui';",
    '',
    'export default function Counter({ first, ready }: { first: number; ready: boolean }) {',
    '  const [count, setCount] = useReactiveState(first);',
    options.before ?? '',
    `  return ${jsx};`,
    '}',
    '',
  ].join('\n');
  using api = openTypeScript();
  using parsed = parseModule(api, 'counter.reactive.tsx', source);
  const { sourceFile } = parsed;
  const fail = failIn(sourceFile, 'counter.reactive.tsx');
  try {
    const component = analyzeComponent({
      classify: () => ({ file: undefined, id: undefined, kind: 'package' }),
      fail,
      fileName: 'counter.reactive.tsx',
      hookOf: (binding) => HOOKS[binding.exported],
      id: 'counter',
      sourceFile,
    });
    const reads = new Collected();
    walk(
      component.declaration,
      {
        declared: component.declared,
        declaring: component.declaring,
        topLevel: new Set(component.names.keys()),
      },
      {
        read: (identifier, space) => {
          reads.add(identifier, space);
        },
      },
      fail,
    );
    const setter = { key: 'count', set: 'u_set', site: 'count', type: 'number' };
    collectWrites({
      captureType: () => 'number',
      declaration: component.declaration,
      declared: component.declared,
      declaring: component.declaring,
      fail,
      holdsFunction: () => false,
      id: component.id,
      items: new Map(),
      names: component.names,
      reads: reads.values,
      setters: new Map([
        ['setCount', options.local === true ? { ...setter, local: true } : setter],
      ]),
      sites: new Map(),
      sourceFile,
      writing: new Map(),
    });
    return 'taken';
  } catch (error) {
    if (error instanceof ReactiveCompileError) {
      return error.reason;
    }
    throw error;
  }
}

function button(handler: string): string {
  return ['<button type="button" onClick={', handler, '}>{count}</button>'].join('');
}

describe('a handler a condition selects', () => {
  it.each([
    { id: 'a condition’s answer', handler: 'ready ? () => setCount(1) : undefined' },
    { id: 'the other answer of a condition', handler: 'ready ? undefined : () => setCount(1)' },
    { id: 'both answers of a condition', handler: 'ready ? () => setCount(1) : () => setCount(2)' },
    { id: 'the right of `&&`', handler: 'ready && (() => setCount(1))' },
    { id: 'the right of `??`', handler: 'undefined ?? (() => setCount(1))' },
    { id: 'the right of `||`', handler: 'undefined || (() => setCount(1))' },
    {
      id: 'a condition in a condition',
      handler: 'ready ? (first > 1 ? () => setCount(1) : undefined) : undefined',
    },
    {
      id: 'a cast of a condition',
      handler: '(ready ? () => setCount(1) : undefined) as (() => void) | undefined',
    },
    { id: 'an update', handler: 'ready ? () => setCount((current) => current + 1) : undefined' },
  ])('takes a function that calls the setter: $id', ({ handler }) => {
    expect(read(button(handler))).toBe('taken');
  });

  it.each([
    { id: 'a condition’s answer', handler: 'ready ? () => setCount(1) : undefined' },
    { id: 'the right of `&&`', handler: 'ready && (() => setCount(1))' },
  ])('takes it for the setter of a local state too: $id', ({ handler }) => {
    expect(read(button(handler), { local: true })).toBe('taken');
  });

  it.each([
    { id: 'a condition’s answer', handler: 'ready ? inc : undefined' },
    { id: 'the right of `&&`', handler: 'ready && inc' },
  ])('takes a constant function that calls the setter: $id', ({ handler }) => {
    expect(read(button(handler), { before: '  const inc = () => {\n    setCount(2);\n  };' })).toBe(
      'taken',
    );
  });

  it('takes the setter handed on, as it is, to a component’s handler a condition selects', () => {
    expect(read('<Checkbox aria-label="x" onCheckedChange={ready ? setCount : undefined} />')).toBe(
      'taken',
    );
  });

  it('takes a handler of a name of a component’s own', () => {
    expect(
      read('<Checkbox aria-label="x" onCheckedChange={ready ? () => setCount(1) : undefined} />'),
    ).toBe('taken');
  });
});

describe('what a condition does not make a handler', () => {
  it.each([
    {
      id: 'a call of the setter as the answer',
      jsx: button('ready ? setCount(1) : undefined'),
      refused: HANDLER_ONLY,
    },
    {
      id: 'a call of the setter beside `&&`',
      jsx: button('ready && setCount(1)'),
      refused: HANDLER_ONLY,
    },
    {
      id: 'the function called at once',
      jsx: button('(ready ? () => setCount(1) : () => setCount(2))()'),
      refused: HANDLER_ONLY,
    },
    {
      id: 'a function of an attribute that is no event',
      jsx: '<p title={ready ? (() => setCount(1))() : undefined}>{count}</p>',
      refused: HANDLER_ONLY,
    },
    {
      id: 'a callback ref',
      jsx: '<p ref={ready ? () => setCount(1) : undefined}>{count}</p>',
      refused: HANDLER_ONLY,
    },
    {
      id: 'a function an event that fires by itself is given',
      jsx: '<img alt="" onLoad={ready ? () => setCount(1) : undefined} />',
      refused: HANDLER_ONLY,
    },
    {
      id: 'the setter handed on to an element of the browser’s',
      jsx: button('ready ? setCount : undefined'),
      refused: HANDED_ON,
    },
    {
      id: 'a constant function that writes, called as the JSX is built',
      jsx: '<p>{ready ? inc() : 0}</p>',
      before: '  const inc = () => {\n    setCount(2);\n  };',
      refused: WRITES,
    },
  ])('still refuses $id', ({ before, jsx, refused }) => {
    expect(read(jsx, { before })).toContain(refused);
  });

  it('still takes a function that is given to the event plainly', () => {
    expect(read(button('() => setCount(1)'))).toBe('taken');
  });
});
