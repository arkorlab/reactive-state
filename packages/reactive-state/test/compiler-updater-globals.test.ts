import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  type Identifier,
  isFunctionTypeNode,
  isPropertySignatureDeclaration,
  isTypeLiteralNode,
} from 'typescript/ast';
import { afterEach, describe, expect, it } from 'vitest';

import { analyzeComponent, type Component } from '../src/compiler/analyze.ts';
import { emitAuthority } from '../src/compiler/emit-authority.ts';
import { failIn } from '../src/compiler/errors.ts';
import { heldThroughHooks } from '../src/compiler/hook-items.ts';
import { HookModules } from '../src/compiler/hooks.ts';
import { Modules } from '../src/compiler/modules.ts';
import { resolveSides, type Sides } from '../src/compiler/sides.ts';
import { literal } from '../src/compiler/splice.ts';
import { functionOf } from '../src/compiler/statements.ts';
import { typeNames } from '../src/compiler/type-names.ts';
import { constantType, propType, startedType } from '../src/compiler/types.ts';
import { openTypeScript } from '../src/compiler/typescript.ts';
import { collectWrites, type Owner, updaterId } from '../src/compiler/updaters.ts';

/**
 * The imports of a component's program for the authority (`emitAuthority`), where a custom hook's
 * update imports a helper of a shared module under the name of a global that another update reads:
 * `import { parseInt } from '@/numbers'` in the hook, `parseInt('12px', 10)` of the language's in the
 * component. The program holds the updates of the component and of its hooks side by side, so an
 * import the program writes under the name takes the global of that name from the update that reads
 * it; each import an update reads is named apart from every global an update reads, as it is
 * from those a dynamic site reads.
 *
 * Each row compiles a small application — a component, the hooks and the shared module it names —
 * through the component's analysis, its sides, its updaters and its program, and reads the text of
 * the program: its imports, and the body of each update.
 */

const api = openTypeScript();
const dirs: string[] = [];

/** The shared module a hook, or a component, imports `parseInt` from: another function than the global. */
const NUMBERS = `export function parseInt(text: string, radix: number): number {
  return Number(text) * 100 + radix;
}
`;

/** Another module that exports a function of that name, of another answer. */
const OTHER = `export function parseInt(text: string, radix: number): number {
  return Number(text) - radix;
}
`;

/** A module that exports a helper of a name no global has. */
const NEUTRAL = `export function widen(text: string, radix: number): number {
  return Number(text) * 100 + radix;
}
`;

const CHILD = `export default function Child({ n }: { n: unknown }) {
  return <i>{String(n)}</i>;
}
`;

/**
 * A hook module of one hook, `name`, whose update is `update` of the current value, which it names
 * `parameter`, after `imports`.
 */
function hook(name: string, update: string, imports = '', parameter = 'current'): string {
  return `import { useReactiveState } from 'framework/react';
import type { FieldRef } from '@arkorlab/reactive-state/program';
${imports}
export function ${name}(ref: FieldRef<number>) {
  const [count, setCount] = useReactiveState(ref);
  const bump = () => {
    setCount((${parameter}) => ${update});
  };
  return [count, bump] as const;
}
`;
}

/** A hook whose update calls `parseInt` imported from the module `from`. */
const importing = (name: string, from: string): string =>
  hook(name, 'parseInt(String(current), 10)', `import { parseInt } from '${from}';`);

/** A hook whose update calls the global `parseInt`. */
const reading = (name: string): string => hook(name, 'parseInt(String(current), 10)');

/** What a component is made of: its imports, the hooks it calls and its own update of the title. */
interface Parts {
  readonly imports?: string;
  readonly hooks?: readonly string[];
  readonly update?: string;
  readonly more?: string;
}

/** A component of a title of the database, and of the hooks of `parts`, each of an estimate. */
function lab(parts: Parts = {}): string {
  const calls = (parts.hooks ?? ['useCount']).map(
    (name, index) =>
      `  const [value${String(index)}, bump${String(index)}] = ${name}(ref.estimate);`,
  );
  const buttons = (parts.hooks ?? ['useCount']).map(
    (_, index) =>
      `      <button type="button" onClick={bump${String(index)}}>{value${String(index)}}</button>`,
  );
  return `import { useReactiveState } from 'framework/react';
import { requireUser } from '@/auth';
import { db } from '@/db';
import { assertCanEditTodo } from '@/permissions';
${(parts.hooks ?? ['useCount']).map((name) => `import { ${name} } from '@/hooks/${name}';`).join('\n')}
${parts.imports ?? ''}
export default async function Lab({ projectId, id }: { projectId: string; id: string }) {
  const user = await requireUser();
  await assertCanEditTodo(user, projectId, id);
  const ref = db.todos.ref(id);
  const [title, setTitle] = useReactiveState(ref.title);
${calls.join('\n')}
${parts.more ?? ''}  return (
    <section>
      <button type="button" onClick={() => setTitle(${parts.update ?? '(current) => String(parseInt(current, 10))'})}>t</button>
${buttons.join('\n')}
    </section>
  );
}
`;
}

const TSCONFIG = JSON.stringify({
  compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } },
});

/** The owner `collectWrites` reads the component's writes of, as the compile builds it. */
function ownerOf(component: Component, sides: Sides): Owner {
  const evaluated = new Set(sides.evaluated.map((state) => state.key));
  const local = new Set(sides.evaluated.filter((state) => state.local).map((state) => state.key));
  const held = heldThroughHooks(component.states);
  for (const state of component.states) {
    const key = state.kind === 'state' ? state.value.text : '';
    if (state.kind === 'state' && state.setter !== undefined && evaluated.has(key)) {
      const set = updaterId(component.id, key, 'set');
      const setter = { key, set, site: key, type: undefined };
      held.setters.set(state.setter.text, local.has(key) ? { ...setter, local: true } : setter);
    }
  }
  const scope = { names: component.names, sourceFile: component.sourceFile };
  const captureType = (identifier: Identifier): string | undefined => {
    const entry = component.names.get(identifier.text);
    if (entry?.kind === 'prop') {
      return propType(component.propsType, entry.prop.name, scope);
    }
    if (entry?.kind === 'state') {
      const key = entry.state.value.text;
      return evaluated.has(key) ? `States[${literal(key)}]` : startedType(entry.state, scope);
    }
    if (entry?.kind === 'hooked') {
      const value = entry.call.hook.items.get(entry.item)?.value;
      const key = value === undefined ? undefined : `${entry.call.prefix}${value}`;
      return key !== undefined && evaluated.has(key) ? `States[${literal(key)}]` : undefined;
    }
    return entry?.kind === 'constant' ? constantType(entry.declaration, scope) : undefined;
  };
  const holdsFunction = (identifier: Identifier): boolean => {
    if (held.setters.has(identifier.text) || held.writing.has(identifier.text)) {
      return true;
    }
    const entry = component.names.get(identifier.text);
    if (entry?.kind === 'constant') {
      return functionOf(entry.declaration) !== undefined;
    }
    const { propsType, sourceFile } = component;
    if (propsType !== undefined && entry?.kind === 'prop' && isTypeLiteralNode(propsType)) {
      const member = propsType.members.find(
        (each) =>
          isPropertySignatureDeclaration(each) && each.name.getText(sourceFile) === entry.prop.name,
      );
      return (
        member !== undefined &&
        isPropertySignatureDeclaration(member) &&
        isFunctionTypeNode(member.type)
      );
    }
    return entry?.kind === 'setter';
  };
  return {
    captureType: (identifier) => {
      return (
        captureType(identifier) ??
        component.fail(`\`${identifier.text}\` is captured by an update.`, identifier)
      );
    },
    declaration: component.declaration,
    declared: component.declared,
    declaring: component.declaring,
    fail: component.fail,
    holdsFunction,
    id: component.id,
    items: new Map(),
    names: component.names,
    reads: sides.browser.values,
    setters: held.setters,
    sites: held.sites,
    sourceFile: component.sourceFile,
    writing: held.writing,
  };
}

/** The program for the authority of the component `files` hold at `components/lab.reactive.tsx`. */
function program(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'reactive-state-updater-globals-'));
  dirs.push(root);
  writeFileSync(path.join(root, 'tsconfig.json'), TSCONFIG);
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
  const id = modules.idOf(file, 'component') ?? fail('No component.');
  const analyzed = analyzeComponent({
    classify: (specifier) => modules.targetOf(specifier, file),
    fail,
    fileName: parsed.name,
    hookOf: (binding) => hooks.hookOf(binding),
    id,
    sourceFile: parsed.sourceFile,
  });
  const sides = resolveSides({ component: analyzed, file, modules });
  const writes = collectWrites(ownerOf(analyzed, sides));
  const written = new Set([...writes.updaters.values()].flatMap((each) => [...each.keys]));
  return emitAuthority({
    buildId: 'build',
    component: analyzed,
    propTypes: typeNames(analyzed.propsType),
    sides,
    updaters: writes.updaters,
    writable: sides.evaluated.map((state) => state.key).filter((key) => written.has(key)),
  });
}

/** The lines of `text` that import from the application's modules, and the body of each update by the key it writes. */
function readOf(text: string): {
  readonly imports: readonly string[];
  readonly updates: Readonly<Record<string, string>>;
} {
  const lines = text.split('\n');
  const imports = lines.filter((line) => {
    return (
      line.startsWith('import ') &&
      line.includes(" from '@/") &&
      !line.includes('@/hooks/') &&
      !line.includes('@/components/') &&
      !line.includes('@/auth') &&
      !line.includes('@/db') &&
      !line.includes('@/permissions')
    );
  });
  const updates: Record<string, string> = {};
  const marker = ', kind: "apply", apply: ';
  for (const line of lines) {
    const at = line.indexOf(marker);
    if (at !== -1) {
      const key = line.slice(line.indexOf('keys: ["') + 'keys: ["'.length, line.indexOf('"]'));
      const written = line.slice(at + marker.length);
      updates[key] = written.slice(
        written.indexOf(' => ') + ' => '.length,
        written.lastIndexOf(' },'),
      );
    }
  }
  return { imports, updates };
}

/** A hook that imports `parseInt` and declares `parseInt$2`, beside a component that reads the global. */
function declaring(update: string, parameter = 'current'): Record<string, string> {
  return {
    'components/lab.reactive.tsx': lab(),
    'hooks/useCount.ts': hook(
      'useCount',
      update,
      "import { parseInt } from '@/numbers';",
      parameter,
    ),
    'numbers.ts': NUMBERS,
  };
}

describe('the imports of a program for the authority, beside the globals its updates read', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  describe('an import is named apart from a global an update reads', () => {
    it("a hook imports `parseInt`, the component's update calls the global", () => {
      const { imports, updates } = readOf(
        program({
          'components/lab.reactive.tsx': lab(),
          'hooks/useCount.ts': importing('useCount', '@/numbers'),
          'numbers.ts': NUMBERS,
        }),
      );

      expect(imports).toStrictEqual(["import { parseInt as parseInt$2 } from '@/numbers';"]);
      expect(updates['title']).toBe('String(parseInt(current, 10))');
      expect(updates['useCount#0.count']).toBe('parseInt$2(String(current), 10)');
    });

    it("the component imports `parseInt` for its update, a hook's update calls the global", () => {
      const { imports, updates } = readOf(
        program({
          'components/lab.reactive.tsx': lab({
            imports: "import { parseInt } from '@/numbers';",
          }),
          'hooks/useCount.ts': reading('useCount'),
          'numbers.ts': NUMBERS,
        }),
      );

      expect(imports).toStrictEqual(["import { parseInt as parseInt$2 } from '@/numbers';"]);
      expect(updates['title']).toBe('String(parseInt$2(current, 10))');
      expect(updates['useCount#0.count']).toBe('parseInt(String(current), 10)');
    });

    it('one hook imports `parseInt`, another calls the global', () => {
      const { imports, updates } = readOf(
        program({
          'components/lab.reactive.tsx': lab({
            hooks: ['useCount', 'useGlobal'],
            update: '(current) => current',
          }),
          'hooks/useCount.ts': importing('useCount', '@/numbers'),
          'hooks/useGlobal.ts': reading('useGlobal'),
          'numbers.ts': NUMBERS,
        }),
      );

      expect(imports).toStrictEqual(["import { parseInt as parseInt$2 } from '@/numbers';"]);
      expect(updates['useCount#0.count']).toBe('parseInt$2(String(current), 10)');
      expect(updates['useGlobal#0.count']).toBe('parseInt(String(current), 10)');
    });

    it('a name that is a global of the language, `Number`, is the same', () => {
      const { imports, updates } = readOf(
        program({
          'components/lab.reactive.tsx': lab({
            update: '(current) => String(Number(current) + 1)',
          }),
          'hooks/useCount.ts': hook(
            'useCount',
            'Number(String(current))',
            "import { Number } from '@/numbers';",
          ),
          'numbers.ts':
            'export function Number(text: string): number {\n  return text.length;\n}\n',
        }),
      );

      expect(imports).toStrictEqual(["import { Number as Number$2 } from '@/numbers';"]);
      expect(updates['title']).toBe('String(Number(current) + 1)');
      expect(updates['useCount#0.count']).toBe('Number$2(String(current))');
    });
  });

  describe('an import is not named by a name an update declares', () => {
    it.each([
      {
        id: 'a constant',
        update: '{ const parseInt$2 = current + 1; return parseInt(String(parseInt$2), 10); }',
        written: '{ const parseInt$2 = current + 1; return parseInt$3(String(parseInt$2), 10); }',
      },
      {
        id: 'a function of its own',
        update:
          '{ function parseInt$2(): number { return 1; } return parseInt(String(parseInt$2()), 10); }',
        written:
          '{ function parseInt$2(): number { return 1; } return parseInt$3(String(parseInt$2()), 10); }',
      },
      {
        id: 'a name a pattern destructures',
        update:
          '{ const { parseInt$2 } = { parseInt$2: current }; return parseInt(String(parseInt$2), 10); }',
        written:
          '{ const { parseInt$2 } = { parseInt$2: current }; return parseInt$3(String(parseInt$2), 10); }',
      },
      {
        id: 'a name a nested function takes as its parameter',
        update:
          '{ const again = (parseInt$2: number): number => parseInt(String(parseInt$2), 10); return again(current); }',
        written:
          '{ const again = (parseInt$2: number): number => parseInt$3(String(parseInt$2), 10); return again(current); }',
      },
    ])(
      '$id, in the update that imports, beside a component that reads the global',
      ({ update, written }) => {
        const { imports, updates } = readOf(program(declaring(update)));

        expect(imports).toStrictEqual(["import { parseInt as parseInt$3 } from '@/numbers';"]);
        expect(updates['title']).toBe('String(parseInt(current, 10))');
        expect(updates['useCount#0.count']).toBe(written);
      },
    );

    it('the current value of the update, named so', () => {
      const { imports, updates } = readOf(
        program(declaring('parseInt(String(parseInt$2), 10)', 'parseInt$2')),
      );

      expect(imports).toStrictEqual(["import { parseInt as parseInt$3 } from '@/numbers';"]);
      expect(updates['useCount#0.count']).toBe('parseInt$3(String(parseInt$2), 10)');
    });

    it('two hooks import different helpers under one name, and the second declares the name its alias would be', () => {
      const { imports, updates } = readOf(
        program({
          'components/lab.reactive.tsx': lab({
            hooks: ['useCount', 'useOther'],
            update: '(current) => current',
          }),
          'hooks/useCount.ts': importing('useCount', '@/numbers'),
          'hooks/useOther.ts': hook(
            'useOther',
            '{ const parseInt$2 = current + 1; return parseInt(String(parseInt$2), 10); }',
            "import { parseInt } from '@/other';",
          ),
          'numbers.ts': NUMBERS,
          'other.ts': OTHER,
        }),
      );

      expect(imports).toStrictEqual([
        "import { parseInt } from '@/numbers';",
        "import { parseInt as parseInt$3 } from '@/other';",
      ]);
      expect(updates['useCount#0.count']).toBe('parseInt(String(current), 10)');
      expect(updates['useOther#0.count']).toBe(
        '{ const parseInt$2 = current + 1; return parseInt$3(String(parseInt$2), 10); }',
      );
    });

    it('a local of another name leaves the alias as it was', () => {
      const { imports, updates } = readOf(
        program(declaring('{ const total = current + 1; return parseInt(String(total), 10); }')),
      );

      expect(imports).toStrictEqual(["import { parseInt as parseInt$2 } from '@/numbers';"]);
      expect(updates['useCount#0.count']).toBe(
        '{ const total = current + 1; return parseInt$2(String(total), 10); }',
      );
    });
  });

  describe('what was named apart before stays so', () => {
    it('two hooks import different helpers under one name', () => {
      const { imports, updates } = readOf(
        program({
          'components/lab.reactive.tsx': lab({
            hooks: ['useCount', 'useOther'],
            update: '(current) => current',
          }),
          'hooks/useCount.ts': importing('useCount', '@/numbers'),
          'hooks/useOther.ts': importing('useOther', '@/other'),
          'numbers.ts': NUMBERS,
          'other.ts': OTHER,
        }),
      );

      expect(imports).toStrictEqual([
        "import { parseInt } from '@/numbers';",
        "import { parseInt as parseInt$2 } from '@/other';",
      ]);
      expect(updates['useCount#0.count']).toBe('parseInt(String(current), 10)');
      expect(updates['useOther#0.count']).toBe('parseInt$2(String(current), 10)');
    });

    it('a dynamic site reads the global `parseInt`, a hook imports the helper', () => {
      const { imports, updates } = readOf(
        program({
          'child.ts': CHILD,
          'components/child.reactive.tsx': CHILD,
          'components/lab.reactive.tsx': lab({
            imports: "import Child from '@/components/child.reactive';",
            more: '  const [n, setN] = useReactiveState(1);\n',
            update: '(current) => current',
          }).replace(
            '    </section>',
            '      <button type="button" onClick={() => setN(n + 1)}>+</button>\n      <Child n={parseInt(String(n), 10)} />\n    </section>',
          ),
          'hooks/useCount.ts': importing('useCount', '@/numbers'),
          'numbers.ts': NUMBERS,
        }),
      );

      expect(imports).toStrictEqual(["import { parseInt as parseInt$2 } from '@/numbers';"]);
      expect(updates['useCount#0.count']).toBe('parseInt$2(String(current), 10)');
    });
  });

  describe('a program without the collision is written as it was', () => {
    it('a hook imports a helper no global is named for', () => {
      const { imports, updates } = readOf(
        program({
          'components/lab.reactive.tsx': lab(),
          'hooks/useCount.ts': hook(
            'useCount',
            'widen(String(current), 10)',
            "import { widen } from '@/neutral';",
          ),
          'neutral.ts': NEUTRAL,
        }),
      );

      expect(imports).toStrictEqual(["import { widen } from '@/neutral';"]);
      expect(updates['title']).toBe('String(parseInt(current, 10))');
      expect(updates['useCount#0.count']).toBe('widen(String(current), 10)');
    });

    it('the component and a hook import the same helper under its name', () => {
      const { imports, updates } = readOf(
        program({
          'components/lab.reactive.tsx': lab({
            imports: "import { parseInt } from '@/numbers';",
          }),
          'hooks/useCount.ts': importing('useCount', '@/numbers'),
          'numbers.ts': NUMBERS,
        }),
      );

      expect(imports).toStrictEqual(["import { parseInt } from '@/numbers';"]);
      expect(updates['title']).toBe('String(parseInt(current, 10))');
      expect(updates['useCount#0.count']).toBe('parseInt(String(current), 10)');
    });

    it('updates read globals other than the name of an import', () => {
      const { imports, updates } = readOf(
        program({
          'components/lab.reactive.tsx': lab({
            imports: "import { widen } from '@/neutral';",
            update: '(current) => String(Math.min(Number(current) + 1, 9))',
          }),
          'hooks/useCount.ts': hook('useCount', 'Math.max(0, current - 1)'),
          'neutral.ts': NEUTRAL,
        }),
      );

      expect(imports).toStrictEqual([]);
      expect(updates['title']).toBe('String(Math.min(Number(current) + 1, 9))');
      expect(updates['useCount#0.count']).toBe('Math.max(0, current - 1)');
    });
  });
});
