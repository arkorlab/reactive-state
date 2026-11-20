import { describe, expect, it } from 'vitest';

import { analyzeComponent } from '../src/compiler/analyze.ts';
import { failIn, ReactiveCompileError } from '../src/compiler/errors.ts';
import type { HookDefinition } from '../src/compiler/hooks.ts';
import { Modules } from '../src/compiler/modules.ts';
import { authorityVisitor, browserVisitor, Collected } from '../src/compiler/reads.ts';
import { walk } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A module of the application's that runs anywhere alike, which the server part imports and writes:
 * the authority runs the server part in its own copy of the module, which every session shares, so
 * a value written there stays for the next render of any. The write is refused where the server part
 * reads the module, and what only reads it, copies it, or hands it to a function, is taken as it
 * was. The browser's code runs in the browser, which has a copy of its own.
 */

/** The custom hooks the component calls, by the name they are imported as: none. */
const HOOKS: Partial<Record<string, HookDefinition>> = {};

const SHARED_MODULE = '@/domain/defaults';

/** The part of what the compile says that names the cause, whichever import is written. */
const SAYS =
  "a shared module of the application's, and the authority runs this code in its own copy";

/** A component whose server part is `body`, and whose JSX is `jsx`, which the browser runs. */
function sourceOf(body: string, jsx: string): string {
  return [
    "import { useReactiveState } from 'framework/react';",
    `import { defaults, helper } from '${SHARED_MODULE}';`,
    "import { loadInto } from '@/lib/load';",
    '',
    'export default function Lab({ first }: { first: number }) {',
    ...body.split('\n').map((line) => `  ${line}`),
    '  const [value, setValue] = useReactiveState(first);',
    `  return ${jsx};`,
    '}',
    '',
  ].join('\n');
}

/** Why a compile of `source` refuses its server part, or its JSX where the browser runs it. */
function reasonOf(source: string, side: 'authority' | 'browser'): string | undefined {
  using api = openTypeScript();
  using parsed = parseModule(api, 'lab.reactive.tsx', source);
  using modules = new Modules(api, process.cwd());
  const { sourceFile } = parsed;
  const fail = failIn(sourceFile, 'lab.reactive.tsx');
  try {
    const component = analyzeComponent({
      classify: (specifier) => {
        return {
          file: undefined,
          id: undefined,
          kind: specifier === SHARED_MODULE ? 'shared' : 'server',
        };
      },
      fail,
      fileName: 'lab.reactive.tsx',
      hookOf: (binding) => HOOKS[binding.exported],
      id: 'lab',
      sourceFile,
    });
    const state = {
      actions: new Map(),
      authority: new Collected(),
      browser: new Collected(),
      component,
      components: new Map(),
      elements: new Map(),
      fail,
      file: 'lab.reactive.tsx',
      libraries: new Set<string>(),
      modules,
      serverFunctions: new Set<string>(),
      siteElements: [],
      slots: [],
    };
    const names = {
      declared: component.declared,
      declaring: component.declaring,
      topLevel: new Set(component.names.keys()),
    };
    if (side === 'authority') {
      for (const statement of component.server) {
        walk(statement, names, authorityVisitor(state, false), fail);
      }
    } else if (component.returned !== undefined) {
      walk(component.returned, names, browserVisitor(state), fail);
    }
    return undefined;
  } catch (error) {
    if (error instanceof ReactiveCompileError) {
      return error.reason;
    }
    throw error;
  }
}

const VIEW = '<p>{String(value)}</p>';

describe('a server part that writes an export of a shared module', () => {
  it.each([
    { id: 'an assignment to a member', body: 'defaults.value = first;' },
    { id: 'a compound assignment', body: 'defaults.value += first;' },
    { id: 'a logical assignment', body: 'defaults.value ??= first;' },
    { id: 'an increment', body: 'defaults.value++;' },
    { id: 'a prefix decrement', body: '--defaults.value;' },
    { id: 'a delete', body: 'delete defaults.value;' },
    { id: 'an assignment to a member of a member', body: 'defaults.items[0] = first;' },
    { id: 'a method of arrays that pushes', body: 'defaults.items.push(first);' },
    { id: 'a method of arrays that sorts', body: 'defaults.items.sort();' },
    {
      id: 'Object.assign with it as the target',
      body: 'Object.assign(defaults, { value: first });',
    },
    {
      id: 'Object.defineProperty',
      body: "Object.defineProperty(defaults, 'value', { value: first });",
    },
    { id: 'a parenthesised target', body: '(defaults).value = first;' },
    { id: 'a non-null target', body: 'defaults!.value = first;' },
  ])('refuses $id', ({ body }) => {
    const reason = reasonOf(sourceOf(body, VIEW), 'authority');

    expect(reason).toContain(SAYS);
    expect(reason).toContain(`\`defaults\` is \`${SHARED_MODULE}\`'s`);
  });

  it('says what to write instead', () => {
    expect(reasonOf(sourceOf('defaults.value = first;', VIEW), 'authority')).toContain(
      'Copy it — `const mine = { ...defaults }` — and write the copy, or keep the value in a state.',
    );
  });

  it.each([
    { id: 'a read', body: 'const shown = defaults.value;' },
    { id: 'a copy that is written', body: 'const mine = { ...defaults };\nmine.value = first;' },
    { id: 'a handing to a function of the server', body: 'loadInto(defaults);' },
    {
      id: 'an Object.assign into a copy',
      body: 'const mine = Object.assign({}, defaults);\nmine.value = first;',
    },
    { id: 'JSON.stringify', body: 'const text = JSON.stringify(defaults);' },
    { id: 'a function of the module', body: 'const next = helper(first);' },
    {
      id: 'a copy of a member that is pushed to',
      body: 'const items = [...defaults.items];\nitems.push(first);',
    },
    { id: 'a copy that is sorted', body: 'const sorted = defaults.items.slice().sort();' },
    { id: 'a map', body: 'const doubled = defaults.items.map((item) => item * 2);' },
    {
      id: 'an Object.assign with it as a source',
      body: 'const merged = Object.assign({ first }, defaults);',
    },
    {
      id: 'an object of its own that is written',
      body: 'const own = { value: first };\nown.value = 2;',
    },
  ])('takes $id', ({ body }) => {
    expect(reasonOf(sourceOf(body, VIEW), 'authority')).toBeUndefined();
  });

  it('takes a write the browser runs, which has a copy of its own', () => {
    const jsx = [
      '<button type="button" onClick={() => { defaults.value = 1; setValue(value + 1); }}>',
      '{String(value)}',
      '</button>',
    ].join('');

    expect(reasonOf(sourceOf('', jsx), 'browser')).toBeUndefined();
  });
});
