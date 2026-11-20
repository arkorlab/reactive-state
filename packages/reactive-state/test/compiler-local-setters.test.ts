import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compileApp } from '../src/compiler/index.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';

/**
 * Where a component's own state's setter may be called, of a state the browser starts from a
 * literal and no dynamic site reads: React's setter, which the page alone applies and which
 * registers nothing at the authority, held to what every setter is — called from the handler of an
 * event a person's action dispatches, and from nothing React calls itself, as the tree is built or
 * as an element commits, where each call would write again on every render a write brings. A
 * handler a condition, `&&`, `||` or `??` selects is a handler, as a function written there is.
 *
 * Each row compiles a small application of one component through the compile's entry
 * (`compileApp`), and reads what it refuses and what it writes.
 */

const api = openTypeScript();
const dirs: string[] = [];

const DATABASE = `import { boolean, database, table, text } from '@arkorlab/reactive-state/server';
export const db = database({
  todos: table({ projectId: text({ maxLength: 64 }), title: text({ maxLength: 200 }), completed: boolean() }),
});
`;

/** A component of a state `count` the browser starts at 0, with `body` as its JSX and `before` ahead of it. */
function component(body: string, before = ''): string {
  return `import { useReactiveState } from 'framework/react';
export default function Lab({ cond, items }: { cond: boolean; items: number[] }) {
  const [count, setCount] = useReactiveState(0);
${before}  return (
    <section>
      ${body}
    </section>
  );
}
`;
}

/** What compiling the application of `files` refused, and wrote. */
function compiled(files: Readonly<Record<string, string>>): {
  readonly outputs: ReadonlyMap<string, string>;
  readonly refusals: readonly string[];
} {
  const root = mkdtempSync(path.join(tmpdir(), 'reactive-state-local-setters-'));
  dirs.push(root);
  writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
  );
  const source = path.join(root, 'src');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
    writeFileSync(path.join(source, name), text);
  }
  mkdirSync(path.join(source, 'app'), { recursive: true });
  const result = compileApp({
    api,
    appDir: path.join(source, 'app'),
    outDir: path.join(root, '.reactive'),
    srcDir: source,
  });
  return {
    outputs: new Map([...result.outputs].map(([file, text]) => [path.relative(root, file), text])),
    refusals: result.refusals.map((refusal) => refusal.message),
  };
}

/** The refusals of the application of one component. */
function refusals(text: string): readonly string[] {
  return compiled({ 'components/lab.reactive.tsx': text, 'db.ts': DATABASE }).refusals;
}

const CALLED = "The setter is called from the handler of an event a person's action dispatches";
const WRITES = 'writes a state, ';

describe('the setter of a state the browser starts, where it may be called', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  describe('called where React calls it, or as the tree is built, it is refused', () => {
    it.each([
      {
        id: 'a callback `ref` that sets, which React calls as the element commits',
        body: '<input ref={() => setCount(count + 1)} />',
        reason: CALLED,
      },
      {
        id: 'a call as a child, which runs as the tree is built',
        body: '<p>{setCount(1)}</p>',
        reason: CALLED,
      },
      {
        id: 'a handler called as a child',
        body: '<p>{bump()}</p>',
        before: '  const bump = () => setCount(count + 1);\n',
        reason: WRITES,
      },
      {
        id: 'a handler given to `ref`',
        body: '<input ref={bump} />',
        before: '  const bump = () => setCount(count + 1);\n',
        reason: WRITES,
      },
    ])('$id', ({ before, body, reason }) => {
      const found = refusals(component(body, before));

      expect(found).toHaveLength(1);
      expect(found[0]).toContain(reason);
    });
  });

  describe('called from the handler of an event a person dispatches, it is taken', () => {
    it.each([
      {
        id: 'a function written in the handler',
        body: '<button type="button" onClick={() => setCount(1)}>{count}</button>',
      },
      {
        id: 'the value computed of the current one',
        body: '<button type="button" onClick={() => setCount(count + 1)}>{count}</button>',
      },
      {
        id: 'an update function',
        body: '<button type="button" onClick={() => setCount((c) => c + 1)}>{count}</button>',
      },
      {
        id: 'the event it is given',
        body: '<input onChange={(event) => setCount(Number(event.currentTarget.value))} />',
      },
      {
        id: 'a condition within the handler',
        body: '<button type="button" onClick={() => { if (cond) setCount(1); }}>{count}</button>',
      },
      {
        id: 'a handler of each item of a list',
        body: '{items.map((item) => <button key={item} type="button" onClick={() => setCount(item)}>{item}</button>)}',
      },
      {
        id: 'the setter given to the handler as it is',
        body: '<button type="button" onClick={setCount as never}>{count}</button>',
      },
      {
        id: 'a handler a constant holds',
        body: '<button type="button" onClick={bump}>{count}</button>',
        before: '  const bump = () => setCount(count + 1);\n',
      },
      {
        id: 'a handler a condition selects, written there',
        body: '<button type="button" onClick={cond ? () => setCount(1) : undefined}>{count}</button>',
      },
      {
        id: 'a handler `&&` selects, written there',
        body: '<button type="button" onClick={cond && (() => setCount(1))}>{count}</button>',
      },
      {
        id: 'a handler a condition selects, of a constant',
        body: '<button type="button" onClick={cond ? bump : undefined}>{count}</button>',
        before: '  const bump = () => setCount(count + 1);\n',
      },
    ])('$id', ({ before, body }) => {
      expect(refusals(component(body, before))).toStrictEqual([]);
    });

    it('is written as it was, with nothing registered at the authority', () => {
      const { outputs, refusals: found } = compiled({
        'components/lab.reactive.tsx': component(
          '<button type="button" onClick={() => setCount(count + 1)}>{count}</button>',
        ),
        'db.ts': DATABASE,
      });

      expect(found).toStrictEqual([]);
      expect(outputs.get('.reactive/components/lab.client.tsx')).toContain(
        'onClick={() => setCount(count + 1)}',
      );
      expect(outputs.get('.reactive/components/lab.authority.mts')).toContain(
        'export const updaters = Object.freeze({});',
      );
    });
  });

  describe('a state a dynamic site reads is held to the same', () => {
    it('a callback `ref` that sets it is refused, as it was', () => {
      const { refusals: found } = compiled({
        'components/child.reactive.tsx':
          'export default function Child({ n }: { n: number }) {\n  return <i>{n}</i>;\n}\n',
        'components/lab.reactive.tsx': [
          "import { useReactiveState } from 'framework/react';",
          "import Child from '@/components/child.reactive';",
          'export default function Lab() {',
          '  const [count, setCount] = useReactiveState(0);',
          '  return (',
          '    <section>',
          '      <input ref={() => setCount(count + 1)} />',
          '      <Child n={count} />',
          '    </section>',
          '  );',
          '}',
          '',
        ].join('\n'),
        'db.ts': DATABASE,
      });

      expect(found).toHaveLength(1);
      expect(found[0]).toContain(CALLED);
    });
  });
});
