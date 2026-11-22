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
 * A custom hook declares its constants with `const`, and a constant may be a pattern:
 * `const { step } = options`, `const [low, high] = range`. Each name the pattern declares is a
 * name of the hook's, declared where the constant stands; a declaration of one of them again,
 * nested in the hook, is refused, as for any name of the hook's.
 */

const dirs: string[] = [];

const HEAD = "import { useReactiveState } from 'framework/react';\n";

/** The component that calls the hook with an options object: `useLab(1, { step: 2 })`. */
const COMPONENT =
  'const { count, bump } = useLab(1, { step: 2 });\nreturn <button type="button" onClick={bump}>{count}</button>;';

/** A hook of a state a parameter feeds, whose handler adds `bumped`, with `constants` before it. */
function hookOf(constants: string, bumped = 'step'): string {
  return `${HEAD}
export function useLab(start: number, options: { readonly step: number }) {
  const [count, setCount] = useReactiveState(start);
${constants}
  const bump = () => {
    setCount(count + ${bumped});
  };
  return { count, bump };
}
`;
}

/** What a compile of the component says of it: why it is refused, or `taken`. */
function read(hook: string): string {
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
      ...COMPONENT.split('\n').map((line) => `  ${line}`),
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

describe('a hook constant that is a pattern', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it.each([
    { id: 'an object pattern of a parameter', constants: '  const { step } = options;' },
    { id: 'an object pattern of an object', constants: '  const { step } = { step: 1 };' },
    { id: 'a renamed property', constants: '  const { step: delta } = options;', bumped: 'delta' },
    { id: 'a default', constants: '  const { step = 1 } = options;' },
    { id: 'an array pattern', constants: '  const [step] = [options.step];' },
    { id: 'a nested pattern', constants: '  const { range: [step] } = { range: [options.step] };' },
    {
      id: 'two patterns',
      constants: '  const { step } = options;\n  const [other] = [step];',
      bumped: 'step + other',
    },
    {
      id: 'a name a plain constant declares (a control)',
      constants: '  const step = options.step;',
    },
  ])('takes $id', ({ bumped, constants }) => {
    expect(read(hookOf(constants, bumped))).toBe('taken');
  });

  it.each([
    {
      id: 'a nested function declaring a name of the pattern again',
      constants:
        '  const { step } = options;\n  const twice = () => {\n    const step = 2;\n    setCount(count + step);\n  };',
      refused: '`step` is one of the top-level names',
    },
    {
      id: 'a state named as a name of the pattern',
      constants: '  const { count: again } = options;\n  const [step, count] = [1, 2];',
      refused: "`count` is a name of the hook's module, or of the hook, already",
    },
    {
      id: 'a pattern naming one name twice',
      constants:
        '  const { step } = options;\n  const { step: other, ...step2 } = options;\n  const [step3, step] = [1, 2];',
      refused: "`step` is a name of the hook's module, or of the hook, already",
    },
  ])('still refuses $id', ({ constants, refused }) => {
    expect(read(hookOf(constants))).toContain(refused);
  });
});
