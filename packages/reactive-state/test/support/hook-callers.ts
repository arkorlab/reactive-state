import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { analyzeComponent } from '../../src/compiler/analyze.ts';
import { failIn, ReactiveCompileError } from '../../src/compiler/errors.ts';
import { heldThroughHooks } from '../../src/compiler/hook-items.ts';
import { HookModules } from '../../src/compiler/hooks.ts';
import { Modules } from '../../src/compiler/modules.ts';
import { Collected } from '../../src/compiler/reads.ts';
import { walk } from '../../src/compiler/scope.ts';
import { openTypeScript } from '../../src/compiler/typescript.ts';
import { collectWrites } from '../../src/compiler/updaters.ts';

/**
 * A component that calls a custom hook, read as a compile reads it up to the check on what its
 * setters write: the hook's module, and the body of the component after the call.
 */

const dirs: string[] = [];

/** Removes the directories the reads made: called when each test ends. */
export function cleanUp(): void {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
}

/** What a compile of the component says of it: why it is refused, or `taken`. */
export function read(hook: string, component: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'reactive-state-hook-callers-'));
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
