import { analyzeComponent } from '../../src/compiler/analyze.ts';
import { failIn, ReactiveCompileError } from '../../src/compiler/errors.ts';
import type { HookDefinition } from '../../src/compiler/hooks.ts';
import { Collected } from '../../src/compiler/reads.ts';
import { walk } from '../../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../../src/compiler/typescript.ts';
import { collectWrites } from '../../src/compiler/updaters.ts';

/**
 * What the writes of a component of one persistent state, `count`, are read as: why they are
 * refused, or how many calls of its setter are registered as an update the authority runs (`apply`)
 * and how many as the value the page sends (`set`).
 */

/** The custom hooks the component calls, by the name they are imported as: none. */
const HOOKS: Partial<Record<string, HookDefinition>> = {};

export interface Registered {
  /** Why the component is refused; none where it is taken. */
  readonly reason: string | undefined;
  /** The calls of the setter registered as an update. */
  readonly applies: number;
  /** The registered updaters that write the value the page sends. */
  readonly sets: number;
}

/** A component whose state is `count`, with `before` ahead of its `return` of `jsx`. */
export function writesOf(jsx: string, before = ''): Registered {
  const source = [
    "import { useReactiveState } from 'framework/react';",
    '',
    'export default function Counter({ first }: { first: number }) {',
    '  const [count, setCount] = useReactiveState(first);',
    before,
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
    const writes = collectWrites({
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
        ['setCount', { key: 'count', set: 'u_set', site: 'count', type: 'number' }],
      ]),
      sites: new Map(),
      sourceFile,
      writing: new Map(),
    });
    return {
      applies: writes.calls.size,
      reason: undefined,
      sets: [...writes.updaters.values()].filter(({ site }) => site.kind === 'set').length,
    };
  } catch (error) {
    if (error instanceof ReactiveCompileError) {
      return { applies: 0, reason: error.reason, sets: 0 };
    }
    throw error;
  }
}
