import { analyzeComponent, type Component } from '../../src/compiler/analyze.ts';
import { failIn } from '../../src/compiler/errors.ts';
import type { HookDefinition } from '../../src/compiler/hooks.ts';
import { holdsPageValue } from '../../src/compiler/locality.ts';
import { Modules } from '../../src/compiler/modules.ts';
import { Collected, type SideState } from '../../src/compiler/reads.ts';
import { walk } from '../../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../../src/compiler/typescript.ts';
import { writtenIn } from '../../src/compiler/writes.ts';

/**
 * A component's server part read as a compile reads it: its source, what it writes to, and whether a
 * state the authority starts of a value reads only values of the page's.
 */

const IMPORTS = [
  "import { useReactiveState } from 'framework/react';",
  "import { defaults, helper } from '@/domain/defaults';",
  "import { fill, loadInto } from '@/lib/load';",
].join('\n');

/** A component whose server part is `body`, and the state it declares last, started from `start`. */
export function sourceOf(body: string, start: string): string {
  return [
    IMPORTS,
    '',
    'export default async function Lab({ first, id }: { first: number; id: string }) {',
    ...body.split('\n').map((line) => `  ${line}`),
    `  const [value, setValue] = useReactiveState(${start});`,
    '  return <button type="button" onClick={() => setValue(value)}>{String(value)}</button>;',
    '}',
    '',
  ].join('\n');
}

/** The custom hooks the component calls, by the name they are imported as: none. */
const HOOKS: Partial<Record<string, HookDefinition>> = {};

/** What each of `read` answers of `source`: the component, the state's start, and the walk. */
function readIn<T>(source: string, read: (component: Component, state: SideState) => T): T {
  using api = openTypeScript();
  using parsed = parseModule(api, 'lab.reactive.tsx', source);
  using modules = new Modules(api, process.cwd());
  const { sourceFile } = parsed;
  const fail = failIn(sourceFile, 'lab.reactive.tsx');
  const component = analyzeComponent({
    classify: (specifier) => {
      return {
        file: undefined,
        id: undefined,
        kind: specifier === '@/domain/defaults' ? 'shared' : 'server',
      };
    },
    fail,
    fileName: 'lab.reactive.tsx',
    hookOf: (binding) => HOOKS[binding.exported],
    id: 'lab',
    sourceFile,
  });
  return read(component, {
    actions: new Map(),
    authority: new Collected(),
    browser: new Collected(),
    component,
    components: new Map(),
    elements: new Map(),
    fail,
    file: 'lab.reactive.tsx',
    libraries: new Set(),
    modules,
    serverFunctions: new Set(),
    siteElements: [],
    slots: [],
  });
}

/** Whether the state of `source` starts from a value of the page's. */
export function isPage(source: string): boolean {
  return readIn(source, (component, state) => {
    const declared = component.states[0];
    if (declared?.kind !== 'state') {
      throw new Error('The component declares one state.');
    }
    return holdsPageValue(declared.input, {
      state,
      walking: (node, visitor) => {
        walk(
          node,
          {
            declared: component.declared,
            declaring: component.declaring,
            topLevel: new Set(component.names.keys()),
          },
          visitor,
          component.fail,
        );
      },
    });
  });
}

/** The names the server part of `body` writes to. */
export function writtenBy(body: string): readonly string[] {
  return readIn(sourceOf(body, 'first'), (component) =>
    [...writtenIn(component)].toSorted((a, b) => a.localeCompare(b)),
  );
}
