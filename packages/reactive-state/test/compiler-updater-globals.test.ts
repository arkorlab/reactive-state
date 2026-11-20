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
 * The same goes for what the program writes of the component as it is — the server part, the
 * initializer of a state the authority evaluates, a slot — which reads the globals of the language
 * too: an import the program writes under a global's name binds the global's reads there to the
 * helper, where the same signatures leave nothing to tell the two apart.
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

/** A module of one helper, of the name of a global, whose answer is not the global's. */
function helperNamed(name: string): string {
  return `export function ${name}(text: string, radix: number): number {\n  return Number(text) * 100 + radix;\n}\n`;
}

/** The message of the refusal `run` ends in. */
function refusalOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

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
  readonly arguments?: string;
  /** Statements of the server part, after its checks. */
  readonly server?: string;
  /** Elements of the section, after its buttons. */
  readonly jsx?: string;
}

/** A component of a title of the database, and of the hooks of `parts`, each of an estimate. */
function lab(parts: Parts = {}): string {
  const calls = (parts.hooks ?? ['useCount']).map(
    (name, index) =>
      `  const [value${String(index)}, bump${String(index)}] = ${name}(${parts.arguments ?? 'ref.estimate'});`,
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
${parts.server ?? ''}  const ref = db.todos.ref(id);
  const [title, setTitle] = useReactiveState(ref.title);
${calls.join('\n')}
${parts.more ?? ''}  return (
    <section>
      <button type="button" onClick={() => setTitle(${parts.update ?? '(current) => String(parseInt(current, 10))'})}>t</button>
${buttons.join('\n')}
${parts.jsx ?? ''}    </section>
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

  describe('an import is not named by a name an update writes that is shaped as an alias', () => {
    /** A hook of a number it is given, `Number$2`, which its update captures, and of an import named `Number`. */
    const CAPTURING = hook(
      'useCount',
      'current + Number$2 + Number(String(current))',
      "import { Number } from '@/numbers';",
    ).replace('(ref: FieldRef<number>)', () => '(ref: FieldRef<number>, Number$2: number)');

    it('a name the update captures, beside a component that reads the global', () => {
      const { imports, updates } = readOf(
        program({
          'components/lab.reactive.tsx': lab({
            arguments: 'ref.estimate, 5',
            update: '(current) => String(Number(current) + 1)',
          }),
          'hooks/useCount.ts': CAPTURING,
          'numbers.ts':
            'export function Number(text: string): number {\n  return text.length;\n}\n',
        }),
      );

      expect(imports).toStrictEqual(["import { Number as Number$3 } from '@/numbers';"]);
      expect(updates['title']).toBe('String(Number(current) + 1)');
      expect(updates['useCount#0.count']).toBe('current + Number$2 + Number$3(String(current))');
    });

    it('a property the update names, which the alias does not read', () => {
      const { imports, updates } = readOf(
        program({
          'components/lab.reactive.tsx': lab(),
          'hooks/useCount.ts': hook(
            'useCount',
            '{ const box = { parseInt$2: current }; return parseInt(String(box.parseInt$2), 10); }',
            "import { parseInt } from '@/numbers';",
          ),
          'numbers.ts': NUMBERS,
        }),
      );

      expect(imports).toStrictEqual(["import { parseInt as parseInt$3 } from '@/numbers';"]);
      expect(updates['useCount#0.count']).toBe(
        '{ const box = { parseInt$2: current }; return parseInt$3(String(box.parseInt$2), 10); }',
      );
    });

    it('a name another update reads, which the alias would equal', () => {
      const { imports, updates } = readOf(
        program({
          'components/lab.reactive.tsx': lab({
            hooks: ['useCount', 'useOther'],
            update: '(current) => current',
          }),
          'hooks/useCount.ts': importing('useCount', '@/numbers'),
          'hooks/useOther.ts': hook(
            'useOther',
            'parseInt(String(current), 10) + parseInt$2',
            "import { parseInt } from '@/other';",
          ).replace('(ref: FieldRef<number>)', () => '(ref: FieldRef<number>, parseInt$2: number)'),
          'numbers.ts': NUMBERS,
          'other.ts': OTHER,
        }),
      );

      expect(imports).toStrictEqual([
        "import { parseInt } from '@/numbers';",
        "import { parseInt as parseInt$3 } from '@/other';",
      ]);
      expect(updates['useOther#0.count']).toBe('parseInt$3(String(current), 10) + parseInt$2');
    });

    it("an update that declares a local of an import's own name leaves the import its name", () => {
      const { imports, updates } = readOf(
        program({
          'components/lab.reactive.tsx': lab({
            update: '(current) => { const widen = 1; return String(current + widen); }',
          }),
          'hooks/useCount.ts': hook(
            'useCount',
            'widen(String(current), 10)',
            "import { parseInt as widen } from '@/numbers';",
          ),
          'numbers.ts': NUMBERS,
        }),
      );

      expect(imports).toStrictEqual(["import { parseInt as widen } from '@/numbers';"]);
      expect(updates['useCount#0.count']).toBe('widen(String(current), 10)');
    });

    it('an import whose own name is shaped as an alias keeps it', () => {
      const { imports, updates } = readOf(
        program({
          'components/lab.reactive.tsx': lab(),
          'hooks/useCount.ts': hook(
            'useCount',
            'step$2(String(current), 10)',
            "import { parseInt as step$2 } from '@/numbers';",
          ),
          'numbers.ts': NUMBERS,
        }),
      );

      expect(imports).toStrictEqual(["import { parseInt as step$2 } from '@/numbers';"]);
      expect(updates['useCount#0.count']).toBe('step$2(String(current), 10)');
    });
  });

  describe('an import is named apart from a global the program reads in what it writes as it is', () => {
    /** The globals of the language a helper may share a name with, each read of what the server part awaited. */
    const READS = [
      { name: 'parseInt', read: 'parseInt(String(todo.estimate), 10)' },
      { name: 'fetch', read: "typeof fetch === 'function' ? todo.estimate : 0" },
      { name: 'structuredClone', read: 'structuredClone({ n: todo.estimate }).n' },
      {
        name: 'URL',
        read: "new URL('https://example.com/' + String(todo.estimate)).pathname.length",
      },
      { name: 'Date', read: 'new Date(todo.estimate).getTime()' },
    ] as const;
    const TODO = '  const todo = await db.todos.get(id);\n';
    const CHILD_IMPORT = "import Child from '@/components/child.reactive';";
    /** The program of a component whose body reads a global as `place` puts it, and a hook that imports a helper of its name. */
    function body(
      name: string,
      place: Pick<Parts, 'imports' | 'jsx' | 'more' | 'server'>,
    ): { readonly imports: readonly string[]; readonly text: string; readonly update: string } {
      const text = program({
        'components/child.reactive.tsx': CHILD,
        'components/lab.reactive.tsx': lab({
          ...place,
          imports: `${CHILD_IMPORT}\n${place.imports ?? ''}`,
          update: '(current) => current',
        }),
        'hooks/useCount.ts': hook(
          'useCount',
          `${name}(String(current), 10)`,
          `import { ${name} } from '@/numbers';`,
        ),
        'numbers.ts': helperNamed(name),
      });
      const { imports, updates } = readOf(text);
      return { imports, text, update: updates['useCount#0.count'] ?? '' };
    }
    const places = [
      {
        id: 'a statement of the server part',
        of: (read: string) => {
          return {
            jsx: '      <Child n={probe} />\n',
            server: `${TODO}  const probe = ${read};\n`,
          };
        },
      },
      {
        id: 'the initializer of a state the authority evaluates',
        of: (read: string) => {
          return {
            more: `  const [count, setCount] = useReactiveState(${read});\n`,
            jsx: '      <button type="button" onClick={() => setCount((c) => c + 1)}>{count}</button>\n',
            server: TODO,
          };
        },
      },
      {
        id: 'a slot, an element the authority renders',
        of: (read: string) => ({ jsx: `      <Child n={${read}} />\n`, server: TODO }),
      },
    ] as const;

    describe.each(places)('$id', ({ of }) => {
      it.each(READS)('reads `$name`, a hook imports a helper of the name', ({ name, read }) => {
        const { imports, text, update } = body(name, of(read));

        expect(imports).toStrictEqual([`import { ${name} as ${name}$2 } from '@/numbers';`]);
        expect(text).toContain(read);
        expect(update).toBe(`${name}$2(String(current), 10)`);
      });
    });

    it('a name the program reads as a global of its own text, `Object`, is the same', () => {
      const { imports, text } = body('Object', { server: TODO });

      expect(imports).toStrictEqual(["import { Object as Object$2 } from '@/numbers';"]);
      expect(text).toContain('export const writable = Object.freeze(');
    });

    it('a name the server part declares, with an alias beside it, is named apart from both', () => {
      const { imports, update } = body('parseInt', {
        jsx: '      <Child n={probe} />\n',
        server: `${TODO}  const parseInt$2 = todo.estimate;\n  const probe = parseInt(String(parseInt$2), 10);\n`,
      });

      expect(imports).toStrictEqual(["import { parseInt as parseInt$3 } from '@/numbers';"]);
      expect(update).toBe('parseInt$3(String(current), 10)');
    });
  });

  describe("a program whose body reads no global of an import's name is written as it was", () => {
    it('the body reads `parseInt`, the hook imports a helper of another name', () => {
      const { imports, updates } = readOf(
        program({
          'components/child.reactive.tsx': CHILD,
          'components/lab.reactive.tsx': lab({
            imports: "import Child from '@/components/child.reactive';",
            jsx: '      <Child n={probe} />\n',
            server:
              '  const todo = await db.todos.get(id);\n  const probe = parseInt(String(todo.estimate), 10);\n',
            update: '(current) => current',
          }),
          'hooks/useCount.ts': hook(
            'useCount',
            'widen(String(current), 10)',
            "import { widen } from '@/neutral';",
          ),
          'neutral.ts': NEUTRAL,
        }),
      );

      expect(imports).toStrictEqual(["import { widen } from '@/neutral';"]);
      expect(updates['useCount#0.count']).toBe('widen(String(current), 10)');
    });

    it('a hook imports a helper named `parseInt`, and no global of the name is read', () => {
      const { imports, updates } = readOf(
        program({
          'components/child.reactive.tsx': CHILD,
          'components/lab.reactive.tsx': lab({
            imports: "import Child from '@/components/child.reactive';",
            jsx: '      <Child n={probe} />\n',
            server:
              '  const todo = await db.todos.get(id);\n  const probe = Number(todo.estimate) + 1;\n',
            update: '(current) => current',
          }),
          'hooks/useCount.ts': importing('useCount', '@/numbers'),
          'numbers.ts': NUMBERS,
        }),
      );

      expect(imports).toStrictEqual(["import { parseInt } from '@/numbers';"]);
      expect(updates['useCount#0.count']).toBe('parseInt(String(current), 10)');
    });

    it("the component's own import of the helper is read by its server part, and a hook imports the same", () => {
      const { imports, updates } = readOf(
        program({
          'components/child.reactive.tsx': CHILD,
          'components/lab.reactive.tsx': lab({
            imports:
              "import Child from '@/components/child.reactive';\nimport { parseInt } from '@/numbers';",
            jsx: '      <Child n={probe} />\n',
            server:
              '  const todo = await db.todos.get(id);\n  const probe = parseInt(String(todo.estimate), 10);\n',
            update: '(current) => current',
          }),
          'hooks/useCount.ts': importing('useCount', '@/numbers'),
          'numbers.ts': NUMBERS,
        }),
      );

      expect(imports).toStrictEqual(["import { parseInt } from '@/numbers';"]);
      expect(updates['useCount#0.count']).toBe('parseInt(String(current), 10)');
    });

    it('a name the server part declares is named apart from the import, as it was', () => {
      const { imports, update } = (() => {
        const text = program({
          'components/child.reactive.tsx': CHILD,
          'components/lab.reactive.tsx': lab({
            imports: "import Child from '@/components/child.reactive';",
            jsx: '      <Child n={todo.estimate} />\n',
            server: '  const todo = await db.todos.get(id);\n',
            update: '(current) => current',
          }),
          'hooks/useCount.ts': hook(
            'useCount',
            'todo(String(current), 10)',
            "import { todo } from '@/numbers';",
          ),
          'numbers.ts': `export function todo(text: string, radix: number): number {\n  return Number(text) + radix;\n}\n`,
        });
        const read = readOf(text);
        return { imports: read.imports, update: read.updates['useCount#0.count'] };
      })();

      expect(imports).toStrictEqual(["import { todo as todo$2 } from '@/numbers';"]);
      expect(update).toBe('todo$2(String(current), 10)');
    });
  });

  describe("a component's import the program keeps under its own name is refused where an update reads a global of it", () => {
    const TODO = '  const todo = await db.todos.get(id);\n';
    const CHILD_IMPORT = "import Child from '@/components/child.reactive';";
    /** The program of a component that imports `name` from the shared module for what the program writes as it is, and a hook whose update reads the global `name`. */
    function withImport(
      name: string,
      place: Pick<Parts, 'jsx' | 'more' | 'server'>,
      update = `${name}(String(current), 10)`,
    ): string {
      return program({
        'components/child.reactive.tsx': CHILD,
        'components/lab.reactive.tsx': lab({
          ...place,
          imports: `${CHILD_IMPORT}\nimport { ${name} } from '@/numbers';`,
          update: '(current) => current',
        }),
        'hooks/useCount.ts': hook('useCount', update),
        'numbers.ts': helperNamed(name),
      });
    }

    describe.each([
      {
        id: 'a statement of the server part',
        of: (read: string) => {
          return {
            jsx: '      <Child n={probe} />\n',
            server: `${TODO}  const probe = ${read};\n`,
          };
        },
      },
      {
        id: 'the initializer of a state the authority evaluates',
        of: (read: string) => {
          return {
            more: `  const [count, setCount] = useReactiveState(${read});\n`,
            jsx: '      <button type="button" onClick={() => setCount((c) => c + 1)}>{count}</button>\n',
            server: TODO,
          };
        },
      },
      {
        id: 'a slot',
        of: (read: string) => ({ jsx: `      <Child n={${read}} />\n`, server: TODO }),
      },
    ] as const)('read by $id', ({ of }) => {
      it.each([
        { name: 'parseInt', read: 'parseInt(String(todo.estimate), 10)' },
        { name: 'structuredClone', read: 'structuredClone({ n: todo.estimate }).n' },
        { name: 'Date', read: 'new Date(todo.estimate).getTime()' },
      ])('imports `$name`, and a hook updates by the global of the name', ({ name, read }) => {
        const message = refusalOf(() => withImport(name, of(read)));

        expect(message).toContain(`\`${name}\` is imported here`);
        expect(message).toContain(
          `the update of \`useCount#0.count\` reads the global \`${name}\``,
        );
        expect(message).toContain('Import it under another name.');
      });
    });

    it('the program renders a reactive element the component imports under the name of a global', () => {
      const message = refusalOf(() => {
        return program({
          'components/child.reactive.tsx': CHILD,
          'components/lab.reactive.tsx': lab({
            imports: "import Date from '@/components/child.reactive';",
            jsx: '      <Date n={1} />\n',
            update: '(current) => current',
          }),
          'hooks/useCount.ts': hook('useCount', 'new Date(current).getTime()'),
        });
      });

      expect(message).toContain('`Date` is imported here');
      expect(message).toContain('reads the global `Date`');
      expect(message).toContain('Import it under another name.');
    });

    it('the same import, and no update reads a global of its name, is written as it was', () => {
      const text = program({
        'components/child.reactive.tsx': CHILD,
        'components/lab.reactive.tsx': lab({
          imports: `${CHILD_IMPORT}\nimport { parseInt } from '@/numbers';`,
          jsx: '      <Child n={probe} />\n',
          server: `${TODO}  const probe = parseInt(String(todo.estimate), 10);\n`,
          update: '(current) => current',
        }),
        'hooks/useCount.ts': hook('useCount', 'Math.max(0, current - 1)'),
        'numbers.ts': NUMBERS,
      });

      expect(readOf(text).imports).toStrictEqual(["import { parseInt } from '@/numbers';"]);
      expect(text).toContain('const probe = parseInt(String(todo.estimate), 10);');
    });

    it("an update reads the global, and no import of the name is the program's own, is written as it was", () => {
      const { imports, updates } = readOf(
        program({
          'components/lab.reactive.tsx': lab({ update: '(current) => current' }),
          'hooks/useCount.ts': hook('useCount', 'parseInt(String(current), 10)'),
        }),
      );

      expect(imports).toStrictEqual([]);
      expect(updates['useCount#0.count']).toBe('parseInt(String(current), 10)');
    });

    it('a type the component imports under the name of a global, which the program erases, is no refusal', () => {
      const text = program({
        'components/child.reactive.tsx': CHILD,
        'components/lab.reactive.tsx': lab({
          imports: `${CHILD_IMPORT}\nimport type { Date } from '@/numbers';`,
          jsx: '      <Child n={probe} />\n',
          server: `${TODO}  const probe: Date | undefined = todo.estimate > 99 ? undefined : undefined;\n`,
          update: '(current) => current',
        }),
        'hooks/useCount.ts': hook('useCount', 'new Date(current).getTime()'),
        'numbers.ts': 'export type Date = { readonly at: number };\n',
      });

      expect(text).toContain('new Date(current).getTime()');
      expect(text).toContain("import type { Date } from '@/numbers';");
    });
  });

  describe("an import's name is reused for an update only where the update holds none", () => {
    /** A shared module of two constants, which a hook imports under another name than the first does. */
    const DELTA = 'export const DELTA = 3;\nexport const OTHER = 7;\n';
    const FIRST = hook('useA', 'current + DELTA', "import { DELTA } from '@/delta';");
    const AS_STEP = "import { DELTA as STEP } from '@/delta';";
    const CHILD_IMPORT = "import Child from '@/components/child.reactive';";

    /** The program of a component with the hooks `useA` and `useB`, `useB` importing `DELTA as STEP`, updating by `update`. */
    function reused(update: string, parameter = 'current', before = ''): ReturnType<typeof readOf> {
      return readOf(
        program({
          'components/lab.reactive.tsx': lab({
            hooks: ['useA', 'useB'],
            update: '(current) => current',
          }),
          'delta.ts': DELTA,
          'hooks/useA.ts': FIRST,
          'hooks/useB.ts': hook('useB', update, AS_STEP, parameter).replace(
            '  const [count',
            () => `${before}  const [count`,
          ),
        }),
      );
    }

    it.each([
      {
        id: 'a parameter named as the first import',
        update: 'DELTA + STEP',
        parameter: 'DELTA',
        before: '',
      },
      {
        id: 'a constant of a block body, declared as the first import is named',
        update: '{ const DELTA = current * 2; return DELTA + STEP; }',
        parameter: 'current',
        before: '',
      },
      {
        id: "a nested function's parameter",
        update: 'current + [1, 2].map((DELTA) => DELTA + STEP).length',
        parameter: 'current',
        before: '',
      },
      {
        id: 'a `catch` binding',
        update: '{ try { return current + STEP; } catch (DELTA) { return STEP + Number(DELTA); } }',
        parameter: 'current',
        before: '',
      },
      {
        id: 'a name the update captures of the hook',
        update: 'current + DELTA + STEP',
        parameter: 'current',
        before: '  const DELTA = 5;\n',
      },
    ])('$id is not read as the import', ({ before, parameter, update }) => {
      const { imports, updates } = reused(update, parameter, before);

      expect(imports).toStrictEqual(["import { DELTA, DELTA as STEP } from '@/delta';"]);
      expect(updates['useA#0.count']).toBe('current + DELTA');
      expect(updates['useB#0.count']).toBe(update);
    });

    it("the name of the component's own import, which its server part reads, is not read as the import either", () => {
      const { imports, updates } = readOf(
        program({
          'components/child.reactive.tsx': CHILD,
          'components/lab.reactive.tsx': lab({
            hooks: ['useB'],
            imports: `${CHILD_IMPORT}\nimport { DELTA } from '@/delta';`,
            jsx: '      <Child n={probe} />\n',
            server:
              '  const todo = await db.todos.get(id);\n  const probe = DELTA + todo.estimate;\n',
            update: '(current) => current',
          }),
          'delta.ts': DELTA,
          'hooks/useB.ts': hook('useB', 'DELTA + STEP', AS_STEP, 'DELTA'),
        }),
      );

      expect(imports).toStrictEqual(["import { DELTA, DELTA as STEP } from '@/delta';"]);
      expect(updates['useB#0.count']).toBe('DELTA + STEP');
    });

    it('a destructured parameter is refused by the rule of an update, as it was', () => {
      const message = refusalOf(() => reused('DELTA + STEP', '{ DELTA }: { DELTA: number }'));

      expect(message).toContain('An update is a function of the current value alone');
    });

    it("an update that holds no such name reads the import under the first one's name, as it did", () => {
      const { imports, updates } = reused('current + STEP');

      expect(imports).toStrictEqual(["import { DELTA } from '@/delta';"]);
      expect(updates['useB#0.count']).toBe('current + DELTA');
    });

    it('a name that is an alias an import is written under is not read as the import', () => {
      const { imports, updates } = readOf(
        program({
          'components/lab.reactive.tsx': lab({
            hooks: ['useA', 'useB'],
            update: '(current) => String(parseInt(current, 10))',
          }),
          'hooks/useA.ts': importing('useA', '@/numbers'),
          'hooks/useB.ts': hook(
            'useB',
            'parseInt$2 + STEP(String(parseInt$2), 10)',
            "import { parseInt as STEP } from '@/numbers';",
            'parseInt$2',
          ),
          'numbers.ts': NUMBERS,
        }),
      );

      expect(imports).toStrictEqual(["import { parseInt as parseInt$3 } from '@/numbers';"]);
      expect(updates['useB#0.count']).toBe('parseInt$2 + parseInt$3(String(parseInt$2), 10)');
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
