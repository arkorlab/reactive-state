import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  type Identifier,
  isCallExpression,
  isExpressionStatement,
  isIdentifier,
  isJsxExpression,
  type Node,
} from 'typescript/ast';
import { afterEach, describe, expect, it } from 'vitest';

import { analyzeComponent } from '../src/compiler/analyze.ts';
import { Derivation } from '../src/compiler/derive.ts';
import { failIn } from '../src/compiler/errors.ts';
import { argumentAt } from '../src/compiler/frames.ts';
import { HookModules } from '../src/compiler/hooks.ts';
import { Modules } from '../src/compiler/modules.ts';
import { type Names, type Visitor, walk } from '../src/compiler/scope.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * Which argument of a custom hook's call a parameter is given, where the call writes a spread: one
 * at or before the place of the parameter gives the parameters after it more or fewer arguments
 * than it names, so the argument written at that place is another parameter's. A dynamic site's
 * value is computed of what a call gives a hook's parameter (`derive.ts`), and a state a hook
 * declares of a parameter is the caller's to start (`hook-sides.ts`): neither takes the argument at
 * the place when a spread stands at or before it. A spread after the place leaves it where it is.
 *
 * Each row writes a component, the hooks it calls and, for a hook that calls a hook, the one it
 * calls, and reads a value of a hook's item as a dynamic site would.
 */

const api = openTypeScript();
const dirs: string[] = [];

/** A hook of a state of its parameter `initial` (the second), of `mode`, which the first, `unused`, leaves out. */
const THING = `import { useReactiveState } from 'framework/react';
export function useThing(initial: string, unused?: string, mode?: string) {
  const [value, setValue] = useReactiveState<string>(initial);
  const shown = mode ?? value;
  return { value, setValue, shown };
}
`;

/** A hook whose state is started of its second parameter, which a spread before it may displace. */
const INNER = `import { useReactiveState } from 'framework/react';
export function useInner(unused: string, initial: string) {
  const [value] = useReactiveState<string>(initial);
  return { value, unused };
}
`;

/** A hook that calls \`useThing\` with \`call\`'s arguments. */
function outer(call: string): string {
  return `import { useReactiveState } from 'framework/react';
import { useThing } from '@/hooks/useThing';
export function useOuter(initial: string, mode: string, other: string) {
  const { shown, value } = useThing(${call});
  const [own] = useReactiveState<string>(other);
  return { shown, own, value };
}
`;
}

/** A hook that calls \`useInner\` with \`call\`'s arguments, and starts a state of its own. */
function nesting(call: string): string {
  return `import { useReactiveState } from 'framework/react';
import { useInner } from '@/hooks/useInner';
export function useNesting(initial: string, other: string) {
  const { value } = useInner(${call});
  const [own] = useReactiveState<string>(other);
  return { own, value };
}
`;
}

/** A component of a state of its own, which calls `call` of the hooks above and reads `item` of it. */
function component(imports: string, call: string, item: string): string {
  return `import { useReactiveState } from 'framework/react';
${imports}
export default function Lab({ first, filter }: { first: string; filter: string }) {
  const [count, setCount] = useReactiveState(0);
  ${call}
  return (
    <section>
      <button type="button" onClick={() => setCount(count + 1)}>+</button>
      {count >= 0 && <p>{${item}}</p>}
    </section>
  );
}
`;
}

/** The identifier `name` that a JSX expression reads. */
function readIn(root: Node, name: string): Identifier | undefined {
  let read: Identifier | undefined;
  const visit = (node: Node): void => {
    if (
      read === undefined &&
      isIdentifier(node) &&
      node.text === name &&
      isJsxExpression(node.parent)
    ) {
      read = node;
    }
    node.forEachChild(visit);
  };
  visit(root);
  return read;
}

const HOOKS = {
  inner: INNER,
  thing: THING,
} as const;

/**
 * Analyzes the component of `files`, and follows a dynamic site's read of `item` into the hooks: what
 * is refused, throws; else the names the authority's program reads of the component's.
 */
function followed(files: Readonly<Record<string, string>>, item: string): readonly string[] {
  const root = mkdtempSync(path.join(tmpdir(), 'reactive-state-hook-spreads-'));
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
  const file = path.join(source, 'components/lab.reactive.tsx');
  using modules = new Modules(api, source);
  const hooks = new HookModules(modules);
  const parsed = modules.parse(file, true);
  const fail = failIn(parsed.sourceFile, parsed.name);
  const analyzed = analyzeComponent({
    classify: (specifier) => modules.targetOf(specifier, file),
    fail,
    fileName: parsed.name,
    hookOf: (binding) => hooks.hookOf(binding),
    id: modules.idOf(file, 'component') ?? fail('No component.'),
    sourceFile: parsed.sourceFile,
  });
  const names: Names = {
    declared: analyzed.declared,
    declaring: analyzed.declaring,
    reserved: new Map<string, string>(),
    topLevel: new Set(analyzed.names.keys()),
  };
  const walking = (node: Node, visitor: Visitor): void => {
    walk(node, names, visitor, analyzed.fail);
  };
  const reads: string[] = [];
  const derivation = new Derivation({
    authority: (read) => {
      reads.push(read.text);
    },
    component: analyzed,
    reserved: new Map<string, string>(),
    walking,
  });
  const identifier = readIn(parsed.sourceFile, item);
  const entry = analyzed.names.get(item);
  if (identifier === undefined || entry === undefined) {
    throw new Error(`no read of ${item}`);
  }
  derivation.read(identifier, entry, { inputs: new Map() });
  return reads;
}

const IMPORT_THING = "import { useThing } from '@/hooks/useThing';";
const IMPORT_OUTER = "import { useOuter } from '@/hooks/useOuter';";
const IMPORT_INNER = "import { useInner } from '@/hooks/useInner';";
const IMPORT_NESTING = "import { useNesting } from '@/hooks/useNesting';";
const GIVEN = 'is given no value of its own by the call to compute a value of';

/** The text of the argument `argumentAt` finds at `index` of the call `source` writes. */
function found(source: string, index: number): string | undefined {
  using parsed = parseModule(api, 'call.ts', source);
  const [statement] = parsed.sourceFile.statements;
  const expression =
    statement !== undefined && isExpressionStatement(statement) ? statement.expression : undefined;
  if (expression === undefined || !isCallExpression(expression)) {
    throw new Error('no call');
  }
  return argumentAt(expression.arguments, index)?.getText(parsed.sourceFile);
}

describe('the argument a hook call gives a parameter, past a spread', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  describe('a parameter after a spread is given no argument of its own', () => {
    it('a site reads an item computed of a parameter, the call spreads before it, in a hook', () => {
      expect(() => {
        followed(
          {
            'components/lab.reactive.tsx': component(
              IMPORT_OUTER,
              "const { shown } = useOuter(first, filter, 'x');",
              'shown',
            ),
            'hooks/useOuter.ts': outer('initial, ...([] as []), mode'),
            'hooks/useThing.ts': HOOKS.thing,
          },
          'shown',
        );
      }).toThrow(GIVEN);
    });

    it('the same call written in the component', () => {
      expect(() => {
        followed(
          {
            'components/lab.reactive.tsx': component(
              IMPORT_THING,
              'const { shown } = useThing(first, ...([] as []), filter);',
              'shown',
            ),
            'hooks/useThing.ts': HOOKS.thing,
          },
          'shown',
        );
      }).toThrow(GIVEN);
    });

    it('a state a hook starts of a parameter, the call spreads before it', () => {
      expect(() => {
        followed(
          {
            'components/lab.reactive.tsx': component(
              IMPORT_INNER,
              'const { value } = useInner(...([] as []), first);',
              'value',
            ),
            'hooks/useInner.ts': HOOKS.inner,
          },
          'value',
        );
      }).toThrow("starts from the hook's parameter");
    });

    it('a hook that calls a hook whose state a parameter starts, the call spreads before it', () => {
      expect(() => {
        followed(
          {
            'components/lab.reactive.tsx': component(
              IMPORT_NESTING,
              'const { value } = useNesting(first, filter);',
              'value',
            ),
            'hooks/useInner.ts': HOOKS.inner,
            'hooks/useNesting.ts': nesting('...([] as []), initial'),
          },
          'value',
        );
      }).toThrow('declares a state with this argument as it is');
    });
  });

  describe('what was refused, or taken, stays so', () => {
    it('a spread at the place of the parameter is refused', () => {
      expect(() => {
        followed(
          {
            'components/lab.reactive.tsx': component(
              IMPORT_THING,
              'const { shown } = useThing(first, undefined, ...([filter] as [string]));',
              'shown',
            ),
            'hooks/useThing.ts': HOOKS.thing,
          },
          'shown',
        );
      }).toThrow(GIVEN);
    });

    it("a spread at the place of a state's parameter is refused, in a hook", () => {
      expect(() => {
        followed(
          {
            'components/lab.reactive.tsx': component(
              IMPORT_NESTING,
              'const { value } = useNesting(first, filter);',
              'value',
            ),
            'hooks/useInner.ts': HOOKS.inner,
            'hooks/useNesting.ts': nesting("'x', ...([initial] as [string])"),
          },
          'value',
        );
      }).toThrow('declares a state with this argument as it is');
    });

    it('a call without a spread is taken, in a hook and in the component', () => {
      const inHook = followed(
        {
          'components/lab.reactive.tsx': component(
            IMPORT_OUTER,
            "const { shown } = useOuter(first, filter, 'x');",
            'shown',
          ),
          'hooks/useOuter.ts': outer('initial, undefined, mode'),
          'hooks/useThing.ts': HOOKS.thing,
        },
        'shown',
      );
      const inComponent = followed(
        {
          'components/lab.reactive.tsx': component(
            IMPORT_THING,
            'const { shown } = useThing(first, undefined, filter);',
            'shown',
          ),
          'hooks/useThing.ts': HOOKS.thing,
        },
        'shown',
      );

      // The parameter `mode` is followed to the argument the call gives it: the prop `filter`.
      expect(inHook).toContain('filter');
      expect(inComponent).toContain('filter');
    });

    it('a spread after the place of the parameter is taken', () => {
      const inHook = followed(
        {
          'components/lab.reactive.tsx': component(
            IMPORT_OUTER,
            "const { shown } = useOuter(first, filter, 'x');",
            'shown',
          ),
          'hooks/useOuter.ts': outer('initial, undefined, mode, ...([] as [])'),
          'hooks/useThing.ts': HOOKS.thing,
        },
        'shown',
      );
      const state = followed(
        {
          'components/lab.reactive.tsx': component(
            IMPORT_NESTING,
            'const { value } = useNesting(first, filter);',
            'value',
          ),
          'hooks/useInner.ts': HOOKS.inner,
          'hooks/useNesting.ts': nesting("'x', initial, ...([] as [])"),
        },
        'value',
      );

      expect(inHook).toContain('filter');
      expect(state).toStrictEqual([]);
    });
  });

  describe('argumentAt', () => {
    it.each([
      { answer: 'c', id: 'no spread: the argument there', index: 2, source: 'f(a, b, c)' },
      { answer: undefined, id: 'no argument there', index: 3, source: 'f(a, b, c)' },
      { answer: undefined, id: 'a spread before it', index: 2, source: 'f(a, ...b, c)' },
      { answer: undefined, id: 'a spread at it', index: 2, source: 'f(a, b, ...c)' },
      { answer: 'b', id: 'a spread after it', index: 1, source: 'f(a, b, ...c)' },
      {
        answer: undefined,
        id: 'a spread first, the first parameter',
        index: 0,
        source: 'f(...a, b)',
      },
    ])('$id', ({ answer, index, source }) => {
      expect(found(source, index)).toBe(answer);
    });
  });
});
