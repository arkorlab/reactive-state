import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  application,
  type Application,
  refusalOf,
  source,
  variant,
} from './fixtures/application.ts';
import { compilerApplications } from './support/compiler-applications.ts';

/**
 * A library is imported on the one side that reads it, as every module was before the shared ones:
 * importing it in the browser would ship the whole of it there. Two specifiers of one file are one
 * library, however the application, or the library, names it — an export of a package's, a `#`
 * import, a `browser` field, a build's condition — so reading it on the authority by one and in the
 * browser by another is refused alike.
 */

const EDITOR = 'components/todo-editor.reactive.tsx';

describe('the compiler, of a library read on both sides of a component', () => {
  const { apps, compile } = compilerApplications();

  /**
   * The TodoEditor, beside a package `gate` whose files all export `allow` and `label`: it reads
   * `allow` from `before` in its server part, and `label` from `after` in its JSX.
   */
  async function withGate(
    manifest: Readonly<Record<string, unknown>>,
    before: string,
    after: string,
    own?: Readonly<Record<string, unknown>>,
  ): Promise<Application> {
    const imported = variant(
      await source(EDITOR),
      "import { db } from '@/db';",
      `import { db } from '@/db';\nimport { allow } from '${before}';\nimport { label } from '${after}';`,
    );
    const allowing = variant(
      imported,
      '  const ref = db.todos.ref(id);',
      "  const ref = db.todos.ref(allow() ? id : '');",
    );
    const editor = variant(allowing, '<p>{status}</p>', '<p>{status}{label}</p>');
    const app = await application({ [EDITOR]: editor });
    apps.push(app);
    const gate = path.join(app.root, 'node_modules/gate');
    await mkdir(gate, { recursive: true });
    await writeFile(
      path.join(gate, 'package.json'),
      JSON.stringify({ name: 'gate', type: 'module', ...manifest }),
    );
    for (const file of ['shared.js', 'client.js', 'server.js', 'main.js']) {
      await writeFile(
        path.join(gate, file),
        "export const allow = () => true;\nexport const label = 'gate';\n",
      );
    }
    if (own !== undefined) {
      await writeFile(
        path.join(app.root, 'package.json'),
        JSON.stringify({ name: 'application', type: 'module', ...own }),
      );
    }
    return app;
  }

  const refused = (app: Application): string => refusalOf(compile(app)).reason;

  it.each([
    [
      'two exports of one file',
      { exports: { '.': './shared.js', './browser': './shared.js' } },
      'gate',
      'gate/browser',
    ],
    [
      'two exports of one file, of an ES module alone',
      { exports: { '.': { import: './shared.js' }, './browser': { import: './shared.js' } } },
      'gate',
      'gate/browser',
    ],
    [
      'the export a bundler takes in a production build',
      {
        exports: {
          '.': JSON.parse('{ "production": "./shared.js", "default": "./client.js" }') as unknown,
          './shared': './shared.js',
        },
      },
      'gate/shared',
      'gate',
    ],
    [
      'the file the package’s `browser` field maps another to',
      { browser: { './server.js': './shared.js' } },
      'gate/shared.js',
      'gate/server.js',
    ],
    [
      'the entry a package of no `exports` names its bundles by',
      { main: './main.js', module: './shared.js' },
      'gate',
      'gate/shared',
    ],
  ])('refuses one read through %s', async (_, manifest, before, after) => {
    const app = await withGate(manifest, before, after);

    expect(refused(app)).toContain(
      `\`label\` is \`${after}\`'s, which the server part reads on the authority`,
    );
  });

  it('refuses one read through two `#` imports of the application that map to one file of a package', async () => {
    const app = await withGate(
      { exports: { '.': './shared.js', './browser': './shared.js' } },
      '#authority',
      '#browser',
      { imports: { '#authority': 'gate', '#browser': 'gate/browser' } },
    );

    expect(refused(app)).toContain(
      "`label` is `#browser`'s, which the server part reads on the authority",
    );
  });

  it('refuses one read through a name the application’s `browser` field replaces with the file it reads', async () => {
    const app = await withGate({ main: './main.js' }, 'gate/shared.js', 'server-lib', {
      browser: { 'server-lib': './node_modules/gate/shared.js' },
    });
    const library = path.join(app.root, 'node_modules/server-lib');
    await mkdir(library, { recursive: true });
    await writeFile(
      path.join(library, 'package.json'),
      JSON.stringify({ main: './index.js', name: 'server-lib' }),
    );
    await writeFile(path.join(library, 'index.js'), "export const label = 'library';\n");

    expect(refused(app)).toContain(
      "`label` is `server-lib`'s, which the server part reads on the authority",
    );
  });

  it('takes a package’s two entry points of two files for two libraries, one on each side', async () => {
    const app = await withGate(
      { exports: { '.': './client.js', './server': './server.js' } },
      'gate/server',
      'gate',
    );

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
