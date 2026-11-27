import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { type Compiled, compileApp, openTypeScript, writeOutputs } from '../src/compiler/index.ts';
import {
  application,
  type Application,
  compiledApp,
  node,
  output,
  removed,
  source,
  typeCheck,
  variant,
} from './fixtures/application.ts';

/**
 * A `'use server'` module the authority registers by its file's name — `*.operations.ts` under the
 * compile's source directory — though no component and no hook imports it: the server hands a page
 * its stub, which the page binds. Its id is its path without its extension, as any module's, and
 * the registry and the stub import it by its path from where each is written, with its extension.
 */

// A whole compile of the fixture runs well past vitest's five seconds on a loaded machine.
vi.setConfig({ hookTimeout: 300_000, testTimeout: 300_000 });

const AUDIT = 'actions/audit.operations.ts';
const NOTES = 'actions/audit-notes.ts';
const SETTINGS = 'components/publication-settings.reactive.tsx';
/** The ids of the fixture's own modules of server operations, which its components import. */
const IMPORTED = ['actions/publication', 'actions/todos'];

/** A source file of `lines`. */
function file(...lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

/** A module of server operations nothing imports, whose one operation reads a module of its own. */
const AUDIT_SOURCE = file(
  "'use server';",
  '',
  "import { requireUser } from '@/auth';",
  "import { auditNote } from '@/actions/audit-notes';",
  '',
  'export async function auditProject(projectId: string): Promise<string> {',
  '  const user = await requireUser();',
  '  return auditNote(projectId, user.id);',
  '}',
);

/** What only the module of server operations imports. */
const NOTES_SOURCE = file(
  'export function auditNote(projectId: string, userId: string): string {',
  "  return projectId + ' audited by ' + userId;",
  '}',
);

/** A `'use server'` module of one operation, for a file the walk is not to register. */
const SKIPPED_SOURCE = file(
  "'use server';",
  '',
  'export async function skipped(): Promise<void> {',
  '  await Promise.resolve();',
  '}',
);

/**
 * What `body` — an expression that reads `registry` — evaluates to, through JSON, in a Node of its
 * own that loads the registry the compile wrote in `root`, as the Node authority loads it
 * (`registerPaths`).
 */
function inAuthority(root: string, body: string): unknown {
  const paths = path.join(import.meta.dirname, '../src/authority/paths.ts');
  const registry = path.join(root, '.reactive', 'authority.mts');
  const ran = node(
    [
      `import { registerPaths } from ${JSON.stringify(paths)};`,
      `registerPaths(${JSON.stringify(path.join(root, 'tsconfig.json'))});`,
      `const registry = await import(${JSON.stringify(registry)});`,
      `process.stdout.write(JSON.stringify(${body}));`,
    ].join('\n'),
    root,
  );
  if (ran.status !== 0) {
    throw new Error(ran.stderr);
  }
  return JSON.parse(ran.stdout) as unknown;
}

/** The modules of operations a compile registers but the fixture's own and the audit's. */
function unexpectedIn(compiled: Compiled): readonly string[] {
  return Object.keys(compiled.manifest?.operations ?? {}).filter(
    (id) => id !== 'actions/audit.operations' && !IMPORTED.includes(id),
  );
}

describe('a module of server operations registered by its file’s name', () => {
  let api: API;
  const apps: Application[] = [];
  /** What a case made beside its application: a link to it, a directory a link leads to. */
  const others: string[] = [];

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    for (const app of apps.splice(0)) {
      await removed(app);
    }
    for (const other of others.splice(0)) {
      await rm(other, { force: true, recursive: true });
    }
  });

  async function compiledWith(
    files: Readonly<Record<string, string>>,
  ): Promise<{ app: Application; compiled: Compiled }> {
    const app = await application(files);
    apps.push(app);
    return { app, compiled: compiledApp(app, api) };
  }

  it('is registered though nothing imports it: in the manifest, the registry, its stub and the elements', async () => {
    const { app, compiled } = await compiledWith({ [AUDIT]: AUDIT_SOURCE, [NOTES]: NOTES_SOURCE });
    const written = (name: string): string =>
      output(compiled, app, name).replaceAll(compiled.buildId, 'b_BUILD');

    expect(compiled.refusals).toStrictEqual([]);
    expect(compiled.manifest?.operations['actions/audit.operations']).toStrictEqual({
      exports: ['auditProject'],
      source: AUDIT,
    });
    // No component or hook imports it, so no specifier of it is classed.
    expect(
      Object.keys(compiled.manifest?.modules ?? {}).filter((specifier) =>
        specifier.includes('audit'),
      ),
    ).toStrictEqual([]);
    expect(written('authority.mts')).toContain(
      "import * as operations$actions$audit_operations from '../src/actions/audit.operations.ts';",
    );
    expect(written('authority.mts')).toContain(
      'export const operations = { "actions/audit.operations": operations$actions$audit_operations, "actions/publication": operations$actions$publication, "actions/todos": operations$actions$todos };',
    );
    expect(written(AUDIT)).toBe(
      file(
        '// Generated by @arkorlab/reactive-state from actions/audit.operations.ts. Do not edit: change the module and compile it again.',
        "'use server';",
        '',
        "import { operate } from '@arkorlab/reactive-state/next';",
        "import type * as source from '../../src/actions/audit.operations.ts';",
        '',
        'export async function auditProject(...args: Parameters<typeof source.auditProject>): Promise<Awaited<ReturnType<typeof source.auditProject>>> {',
        '  return operate("actions/audit.operations", "auditProject", args, "b_BUILD") as Promise<Awaited<ReturnType<typeof source.auditProject>>>;',
        '}',
      ),
    );
    expect(written('elements.ts')).toContain(
      "import { auditProject as action$actions$audit_operations_auditProject } from './actions/audit.operations';",
    );
    expect(written('elements.ts')).toContain(
      '"actions/audit.operations#auditProject": action$actions$audit_operations_auditProject,',
    );
  });

  it('writes what the type check accepts, a page’s binding of its stub too, and what the Node authority loads', async () => {
    const { app, compiled } = await compiledWith({ [AUDIT]: AUDIT_SOURCE, [NOTES]: NOTES_SOURCE });
    writeOutputs(compiled.outputs, app.out);
    await writeFile(
      path.join(app.root, 'probe.mts'),
      file(
        "import { auditProject } from './.reactive/actions/audit.operations.ts';",
        '',
        "export const audit: () => Promise<string> = auditProject.bind(null, 'p1');",
      ),
    );
    const checked = typeCheck(app);

    expect(checked.stdout + checked.stderr).toBe('');
    expect(checked.status).toBe(0);
    expect(
      inAuthority(
        app.root,
        "Object.entries(registry.operations['actions/audit.operations']).map(([name, value]) => [name, typeof value])",
      ),
    ).toStrictEqual([['auditProject', 'function']]);
  });

  it('moves the build’s id where it changes, or a module only it imports does, and says it read both', async () => {
    const { app, compiled: first } = await compiledWith({
      [AUDIT]: AUDIT_SOURCE,
      [NOTES]: NOTES_SOURCE,
    });
    await writeFile(path.join(app.src, AUDIT), `${AUDIT_SOURCE}// Audited at each publication.\n`);
    const changed = compiledApp(app, api);
    await writeFile(path.join(app.src, NOTES), variant(NOTES_SOURCE, ' audited by ', ' read by '));
    const imported = compiledApp(app, api);
    const reads = [...first.reads.keys()];

    expect(first.refusals).toStrictEqual([]);
    expect(reads).toContain(realpathSync(path.join(app.src, AUDIT)));
    expect(reads).toContain(realpathSync(path.join(app.src, NOTES)));
    expect(changed.buildId).not.toBe(first.buildId);
    expect(imported.buildId).not.toBe(changed.buildId);
  });

  it('is imported by its path from the outputs as the compile was given them, through a link to the application', async () => {
    const app = await application({ [AUDIT]: AUDIT_SOURCE, [NOTES]: NOTES_SOURCE });
    apps.push(app);
    const linked = `${app.root}-linked`;
    await symlink(app.root, linked, 'dir');
    others.push(linked);
    const outDir = path.join(linked, '.reactive');
    const compiled = compileApp({
      api,
      appDir: path.join(linked, 'src', 'app'),
      outDir,
      srcDir: path.join(linked, 'src'),
    });
    const unlinked = compiledApp(app, api);
    const written = (made: Compiled, root: string, name: string): string | undefined =>
      made.outputs.get(path.join(root, '.reactive', name))?.replaceAll(made.buildId, 'b_BUILD');
    writeOutputs(compiled.outputs, outDir);

    expect(compiled.refusals).toStrictEqual([]);
    expect(written(compiled, linked, 'authority.mts')).toContain(
      "import * as operations$actions$audit_operations from '../src/actions/audit.operations.ts';",
    );
    expect(written(compiled, linked, AUDIT)).toContain(
      "import type * as source from '../../src/actions/audit.operations.ts';",
    );
    // Through the link, the registry and the stub are what they are of the application's own path.
    expect(written(compiled, linked, 'authority.mts')).toBe(
      written(unlinked, app.root, 'authority.mts'),
    );
    expect(written(compiled, linked, AUDIT)).toBe(written(unlinked, app.root, AUDIT));
    expect(inAuthority(linked, 'Object.keys(registry.operations)')).toStrictEqual([
      'actions/audit.operations',
      ...IMPORTED,
    ]);
  });

  // A pin: an imported module was registered so before it could be named.
  it('writes a module both imported and so named once, imported as its importer writes it', async () => {
    const settings = variant(
      variant(
        await source(SETTINGS),
        "import { publishBoard, withdrawBoard } from '@/actions/publication';",
        "import { publishBoard, withdrawBoard } from '@/actions/publication';\nimport { auditProject } from '@/actions/audit.operations';",
      ),
      '<form action={publishBoard.bind(null, projectId)}>',
      '<form action={auditProject.bind(null, projectId)}>\n        <button type="submit">監査する</button>\n      </form>\n      <form action={publishBoard.bind(null, projectId)}>',
    );
    const { app, compiled } = await compiledWith({
      [AUDIT]: AUDIT_SOURCE,
      [NOTES]: NOTES_SOURCE,
      [SETTINGS]: settings,
    });
    const registry = output(compiled, app, 'authority.mts');

    expect(compiled.refusals).toStrictEqual([]);
    expect(
      registry.split('\n').filter((line) => line.startsWith('import') && line.includes('audit')),
    ).toStrictEqual([
      "import * as operations$actions$audit_operations from '@/actions/audit.operations';",
    ]);
    expect(output(compiled, app, AUDIT)).toContain(
      "import type * as source from '@/actions/audit.operations';",
    );
    expect(Object.keys(compiled.manifest?.operations ?? {})).toStrictEqual([
      'actions/audit.operations',
      ...IMPORTED,
    ]);
    expect(compiled.manifest?.modules['@/actions/audit.operations']).toBe('operations');
  });

  // A pin: the walk skips what it skipped of components before it found modules of operations.
  it('registers none of a hidden directory, a package, the compile’s own output or a link', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'reactive-state-operation-files-'));
    others.push(outside);
    await writeFile(path.join(outside, 'linked.operations.ts'), SKIPPED_SOURCE);
    const app = await application({
      [AUDIT]: AUDIT_SOURCE,
      [NOTES]: NOTES_SOURCE,
      '.hidden/hidden.operations.ts': SKIPPED_SOURCE,
      'generated/stale.operations.ts': SKIPPED_SOURCE,
      'node_modules/audit/packaged.operations.ts': SKIPPED_SOURCE,
    });
    apps.push(app);
    await symlink(outside, path.join(app.src, 'linked'), 'dir');
    await symlink(
      path.join(outside, 'linked.operations.ts'),
      path.join(app.src, 'actions', 'linked.operations.ts'),
      'file',
    );
    // The compile writes into the source directory: each stub of its own is a `'use server'` module
    // of its source's name, which a compile after it would find.
    const options = {
      api,
      appDir: app.appDir,
      outDir: path.join(app.src, 'generated'),
      srcDir: app.src,
    };
    const first = compileApp(options);
    writeOutputs(first.outputs, options.outDir);
    const again = compileApp(options);

    expect([first, again].map((compiled) => compiled.refusals)).toStrictEqual([[], []]);
    expect([first, again].map((compiled) => unexpectedIn(compiled))).toStrictEqual([[], []]);
  });

  it('registers no stub of its own where it writes into the source directory through a link', async () => {
    const app = await application({ [AUDIT]: AUDIT_SOURCE, [NOTES]: NOTES_SOURCE });
    apps.push(app);
    const linked = `${app.root}-linked`;
    await symlink(app.root, linked, 'dir');
    others.push(linked);
    const options = {
      api,
      appDir: path.join(linked, 'src', 'app'),
      outDir: path.join(linked, 'src', 'generated'),
      srcDir: path.join(linked, 'src'),
    };
    const first = compileApp(options);
    writeOutputs(first.outputs, options.outDir);
    const again = compileApp(options);

    expect(again.refusals).toStrictEqual([]);
    expect(unexpectedIn(again)).toStrictEqual([]);
  });

  it('takes a test runner’s manual mocks for none, of no directive or of `use server`', async () => {
    // A mock bears the name of the module it stands in for (`__mocks__/<name>`), and, of no
    // directive, would refuse the compile; of `'use server'`, it would be registered and shipped.
    const { compiled } = await compiledWith({
      [AUDIT]: AUDIT_SOURCE,
      [NOTES]: NOTES_SOURCE,
      'actions/__mocks__/audit.operations.ts':
        'export async function auditProject(): Promise<string> {\n  return "audited";\n}\n',
      'components/__mocks__/settings.operations.ts': SKIPPED_SOURCE,
    });

    expect(compiled.refusals).toStrictEqual([]);
    expect(unexpectedIn(compiled)).toStrictEqual([]);
  });

  // A pin: a stub the compile no longer writes was always taken away with its registry's entry.
  it('takes its stub away, and its registry’s import, once its file is gone', async () => {
    const { app, compiled: first } = await compiledWith({
      [AUDIT]: AUDIT_SOURCE,
      [NOTES]: NOTES_SOURCE,
    });
    writeOutputs(first.outputs, app.out);
    await rm(path.join(app.src, AUDIT));
    const again = compiledApp(app, api);
    const outputs = writeOutputs(again.outputs, app.out);

    expect(again.refusals).toStrictEqual([]);
    expect(outputs.filter((each) => each.leftover).map((each) => each.path)).toStrictEqual([
      path.join(app.out, AUDIT),
    ]);
    expect(existsSync(path.join(app.out, AUDIT))).toBe(false);
    expect(output(again, app, 'authority.mts')).not.toContain('audit');
  });

  // A pin: the paths as a person gives them on the command line, from the project's directory.
  it('is imported by its path from the outputs where the command line names its directories relatively', async () => {
    const app = await application({ [AUDIT]: AUDIT_SOURCE, [NOTES]: NOTES_SOURCE });
    apps.push(app);
    const entry = path.join(import.meta.dirname, '../src/compiler/cli.ts');
    const ran = spawnSync(
      process.execPath,
      [entry, 'src', '--out', '.reactive', '--app', path.join('src', 'app')],
      { cwd: app.root, encoding: 'utf8' },
    );
    const written = (name: string): string => readFileSync(path.join(app.out, name), 'utf8');

    // The command line says on standard error each file it wrote; a refusal would end it in 1, and
    // what it said is then what fails.
    expect(ran.status === 0 ? 0 : ran.stderr).toBe(0);
    expect(written('authority.mts')).toContain(
      "import * as operations$actions$audit_operations from '../src/actions/audit.operations.ts';",
    );
    expect(written(AUDIT)).toContain(
      "import type * as source from '../../src/actions/audit.operations.ts';",
    );
    expect(inAuthority(app.root, 'Object.keys(registry.operations)')).toStrictEqual([
      'actions/audit.operations',
      ...IMPORTED,
    ]);
  });

  // A pin: no file but a `.operations.ts` one was ever registered by its name.
  it('takes a file of another extension for none: `.operations.tsx`, `.mts`, `.test.ts` or `.d.ts`', async () => {
    const { compiled } = await compiledWith({
      'actions/audit.operations.d.ts':
        'export declare function auditProject(projectId: string): Promise<string>;\n',
      'actions/audit.operations.mts': SKIPPED_SOURCE,
      'actions/audit.operations.test.ts': "export const audited = 'audited';\n",
      'actions/view.operations.tsx': SKIPPED_SOURCE,
    });

    expect(compiled.refusals).toStrictEqual([]);
    expect(Object.keys(compiled.manifest?.operations ?? {})).toStrictEqual(IMPORTED);
  });
});
