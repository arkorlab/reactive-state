import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { analyzeComponent } from '../src/compiler/analyze.ts';
import { failIn, ReactiveCompileError } from '../src/compiler/errors.ts';
import { heldThroughHooks } from '../src/compiler/hook-items.ts';
import { HookModules } from '../src/compiler/hooks.ts';
import { Modules } from '../src/compiler/modules.ts';
import { Collected } from '../src/compiler/reads.ts';
import { walk } from '../src/compiler/scope.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';
import { collectWrites } from '../src/compiler/updaters.ts';

/**
 * A custom hook's state that no parameter feeds — `useReactiveState(0)` — is React's alone, as a
 * local state's is: its setter is called from the handler of an event a person's action dispatches
 * and from nothing React calls as it renders, wherever the hook's function that calls it, or the
 * setter itself, is handed on. A hook's own code, and the code that calls the hook, are read alike.
 */

const dirs: string[] = [];

const HEAD = "import { useReactiveState } from 'framework/react';\n";

/** A hook of a state started by a literal, which returns its value and a function that writes it. */
const OBJECT_HOOK = `${HEAD}
export function useLab(start: number) {
  const [count, setCount] = useReactiveState(0);
  const bump = () => {
    setCount(count + start);
  };
  return { count, bump };
}
`;

/** The same hook, returning its items by place and the setter itself. */
const ARRAY_HOOK = `${HEAD}
export function useLab(start: number) {
  const [count, setCount] = useReactiveState(0);
  const bump = () => {
    setCount(count + start);
  };
  return [count, bump, setCount] as const;
}
`;

/** A hook of a state a parameter feeds, which the compile has always read: the pin. */
const FED_HOOK = `${HEAD}
export function useLab(start: number) {
  const [count, setCount] = useReactiveState(start);
  const bump = () => {
    setCount(count + 1);
  };
  return { count, bump };
}
`;

/** A hook of one state a parameter feeds, and one it starts itself. */
const MIXED_HOOK = `${HEAD}
export function useLab(start: number) {
  const [count, setCount] = useReactiveState(start);
  const [shown, setShown] = useReactiveState(0);
  const bump = () => {
    setCount(count + 1);
    setShown(shown + 1);
  };
  return { count, shown, bump };
}
`;

/** What a compile of the component says of it: why it is refused, or `taken`. */
function read(hook: string, component: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'reactive-state-hook-unfed-'));
  dirs.push(dir);
  mkdirSync(path.join(dir, 'hooks'));
  mkdirSync(path.join(dir, 'components'));
  writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }),
  );
  writeFileSync(path.join(dir, 'hooks/use-lab.ts'), hook);
  const file = path.join(dir, 'components/lab.reactive.tsx');
  writeFileSync(
    file,
    [
      "import { useLab } from '@/hooks/use-lab';",
      '',
      'export default function Lab() {',
      ...component.split('\n').map((line) => `  ${line}`),
      '}',
      '',
    ].join('\n'),
  );
  using api = openTypeScript();
  using modules = new Modules(api, dir);
  try {
    compile(file, modules);
    return 'taken';
  } catch (error) {
    if (error instanceof ReactiveCompileError) {
      return error.reason;
    }
    throw error;
  }
}

/** The component read as a compile reads it, up to the check on what its setters write. */
function compile(file: string, modules: Modules): void {
  const hooks = new HookModules(modules);
  const parsed = modules.parse(file, true);
  const fail = failIn(parsed.sourceFile, parsed.name);
  const component = analyzeComponent({
    classify: (specifier) => modules.targetOf(specifier, file),
    fail,
    fileName: parsed.name,
    hookOf: (binding) => hooks.hookOf(binding),
    id: modules.idOf(file, 'component') ?? 'lab',
    sourceFile: parsed.sourceFile,
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
  const held = heldThroughHooks(component.states);
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
    setters: held.setters,
    sites: held.sites,
    sourceFile: component.sourceFile,
    writing: held.writing,
  });
}

/** A hook of a state started by a literal, with `constants` between its state and its `return`. */
function unfed(constants: string): string {
  return `${HEAD}\nexport function useLab(start: number) {\n  const [count, setCount] = useReactiveState(0);\n${constants}  return { count, start, setCount };\n}\n`;
}

const WRITES = 'writes a state, so it is called, or handed on, from the handler of an event';
const CALLED = 'The setter is called from the handler of an event a person';
const GIVEN = 'writes a state, and given to a call as the JSX is built';
const COMMITTED = 'writes a state, and React calls what `ref` is given itself';
const ITEMS = 'What `useLab` returns is named item by item where it is called';

describe('a hook of a state no parameter feeds', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  describe('what a hook with a state no parameter feeds lets its callers do with what writes it', () => {
    it.each([
      {
        id: 'a constant calls the function',
        body: 'const { count, bump } = useLab(1);\nconst shown = bump();\nreturn <p>{count}{shown}</p>;',
        hook: OBJECT_HOOK,
        refused: WRITES,
      },
      {
        id: 'the JSX calls the function',
        body: 'const { count, bump } = useLab(1);\nreturn <p>{count}{bump()}</p>;',
        hook: OBJECT_HOOK,
        refused: WRITES,
      },
      {
        id: 'an event attribute is given the result of a call',
        body: 'const { count, bump } = useLab(1);\nreturn <button onClick={bump()}>{count}</button>;',
        hook: OBJECT_HOOK,
        refused: WRITES,
      },
      {
        id: 'the function is a callback ref',
        body: 'const { count, bump } = useLab(1);\nreturn <p ref={bump}>{count}</p>;',
        hook: OBJECT_HOOK,
        refused: COMMITTED,
      },
      {
        id: 'the function is handed to a call as the JSX is built',
        body: 'const { count, bump } = useLab(1);\nreturn <p>{count}{[1].map(bump)}</p>;',
        hook: OBJECT_HOOK,
        refused: GIVEN,
      },
      {
        id: 'the setter is called as the JSX is built',
        body: 'const [count, bump, setCount] = useLab(1);\nreturn <p>{count}{setCount(2)}</p>;',
        hook: ARRAY_HOOK,
        refused: CALLED,
      },
      {
        id: 'the hook of a state a parameter feeds (pinned: refused before, too)',
        body: 'const { count, bump } = useLab(1);\nreturn <button onClick={bump()}>{count}</button>;',
        hook: FED_HOOK,
        refused: WRITES,
      },
      {
        id: 'a hook of a state a parameter feeds, bound whole (pinned: refused before, too)',
        body: 'const lab = useLab(1);\nreturn <button onClick={lab.bump}>{lab.count}</button>;',
        hook: FED_HOOK,
        refused: ITEMS,
      },
      {
        id: 'a hook of a state a parameter feeds and one it starts, bound whole (pinned)',
        body: 'const lab = useLab(1);\nreturn <button onClick={lab.bump}>{lab.count}</button>;',
        hook: MIXED_HOOK,
        refused: ITEMS,
      },
    ])('refuses a render that calls it: $id', ({ body, hook, refused }) => {
      expect(read(hook, body)).toContain(refused);
    });

    it.each([
      {
        id: 'the function is an event handler',
        body: 'const { count, bump } = useLab(1);\nreturn <button onClick={bump}>{count}</button>;',
        hook: OBJECT_HOOK,
      },
      {
        id: 'a handler calls the function',
        body: 'const { count, bump } = useLab(1);\nreturn <button onClick={() => bump()}>{count}</button>;',
        hook: OBJECT_HOOK,
      },
      {
        id: 'a handler calls the setter',
        body: 'const [count, bump, setCount] = useLab(1);\nreturn <button onClick={() => setCount(2)}>{count}</button>;',
        hook: ARRAY_HOOK,
      },
      {
        id: 'the setter is handed on as React’s own',
        body: 'const [count, bump, setCount] = useLab(1);\nreturn <input value={count} onChange={() => setCount(3)} />;',
        hook: ARRAY_HOOK,
      },
      {
        id: 'the value alone is read, and mapped as the JSX is built',
        body: 'const { count } = useLab(1);\nreturn <p>{[count].map((each) => each + 1)}</p>;',
        hook: OBJECT_HOOK,
      },
      {
        id: 'what the hook returns is bound whole and only read',
        body: 'const lab = useLab(1);\nreturn <p>{lab.count}</p>;',
        hook: `${HEAD}\nexport function useLab(start: number) {\n  const [count] = useReactiveState(0);\n  return { count, start };\n}\n`,
      },
      {
        id: 'what the hook returns is bound whole, and its value read (pinned: taken before, too)',
        body: 'const lab = useLab(1);\nreturn <p>{lab.count}</p>;',
        hook: OBJECT_HOOK,
      },
      {
        id: 'what the hook returns is bound whole, and its function an event handler (pinned)',
        body: 'const lab = useLab(1);\nreturn <button onClick={lab.bump}>{lab.count}</button>;',
        hook: OBJECT_HOOK,
      },
      {
        id: 'what the hook returns is bound whole, and a handler calls its function (pinned)',
        body: 'const lab = useLab(1);\nreturn <button onClick={() => lab.bump()}>{lab.count}</button>;',
        hook: OBJECT_HOOK,
      },
      {
        id: 'what the hook returns is bound whole, an array, and a handler calls its setter (pinned)',
        body: 'const lab = useLab(1);\nreturn <button onClick={() => lab[2](5)}>{lab[0]}</button>;',
        hook: ARRAY_HOOK,
      },
    ])('takes what a handler does: $id', ({ body, hook }) => {
      expect(read(hook, body)).toBe('taken');
    });
  });

  describe('what a hook with a state no parameter feeds does with its own setter', () => {
    it.each([
      {
        id: 'a constant calls the setter as the hook runs',
        hook: unfed('  const reset = count > 9 ? setCount(0) : 0;\n'),
        refused: CALLED,
      },
      {
        id: 'a constant hands the setter to a call as the hook runs',
        hook: unfed('  const all = [1, 2].map(setCount);\n'),
        refused: GIVEN,
      },
    ])('refuses a call while it runs: $id', ({ hook, refused }) => {
      expect(read(hook, 'const { count } = useLab(1);\nreturn <p>{count}</p>;')).toContain(refused);
    });

    it('takes a function that calls it from a handler', () => {
      const hook = unfed('  const reset = () => {\n    setCount(0);\n  };\n');

      expect(read(hook, 'const { count } = useLab(1);\nreturn <p>{count}</p>;')).toBe('taken');
    });
  });
});
