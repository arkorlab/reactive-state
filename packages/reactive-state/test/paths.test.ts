import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it, onTestFinished } from 'vitest';

/**
 * `registerPaths` as an authority's process uses it: registered by a module given to `--import`,
 * before the program that imports the application's modules is loaded. Each case runs in a Node of
 * its own, since Vitest loads the suites' modules through a loader of its own, not Node's.
 */

const PATHS = fileURLToPath(new URL('../src/authority/paths.ts', import.meta.url));

interface Ran {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** A tsconfig of `@/*` aliases to the application's root, with a comment and trailing commas. */
const ROOT_ALIASES = [
  '{',
  '  // The application root, as Next.js names it.',
  '  "compilerOptions": { "paths": { "@/*": ["./*"], }, },',
  '}',
].join('\n');

/** An application directory with `tsconfig` and its modules. */
async function application(
  files: Readonly<Record<string, string>>,
  tsconfig = ROOT_ALIASES,
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'reactive-paths-'));
  onTestFinished(async () => {
    await rm(directory, { force: true, recursive: true });
  });
  await writeFile(path.join(directory, 'tsconfig.json'), tsconfig);
  await writeFile(
    path.join(directory, 'register.mts'),
    `import { registerPaths } from ${JSON.stringify(PATHS)};\nregisterPaths(${JSON.stringify(path.join(directory, 'tsconfig.json'))});\n`,
  );
  for (const [name, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), source);
  }
  return directory;
}

/** A directory of `files` beside the application's rather than in it, as another package's is. */
async function elsewhere(files: Readonly<Record<string, string>>): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'reactive-elsewhere-'));
  onTestFinished(async () => {
    await rm(directory, { force: true, recursive: true });
  });
  for (const [name, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), source);
  }
  return directory;
}

/** A package that answers `name` from the package `permissions` it depends on. */
const DEPENDS_ON_PERMISSIONS = {
  'index.js': "export { name } from 'permissions';\n",
  'node_modules/permissions/index.js': "export const name = 'the package';\n",
  'node_modules/permissions/package.json': '{ "type": "module", "main": "index.js" }',
  'package.json': '{ "type": "module", "main": "index.js" }',
} as const;

/** The package that depends on `permissions`, at `directory`, a directory of the application's. */
function dependencyAt(directory: string): Record<string, string> {
  const files = Object.entries(DEPENDS_ON_PERMISSIONS);
  return Object.fromEntries(files.map(([name, source]) => [`${directory}/${name}`, source]));
}

/** `main.mts` of the application — or what `program` says — in a Node that registered its aliases first. */
async function run(directory: string, program: readonly string[] = ['main.mts']): Promise<Ran> {
  try {
    const { stderr, stdout } = await promisify(execFile)(
      process.execPath,
      ['--import', './register.mts', ...program],
      { cwd: directory },
    );
    return { code: 0, stderr, stdout };
  } catch (error) {
    const failed = error as {
      readonly stdout?: string;
      readonly stderr?: string;
      readonly code?: number;
    };
    return { code: failed.code ?? 1, stderr: failed.stderr ?? '', stdout: failed.stdout ?? '' };
  }
}

describe('registerPaths', () => {
  it('resolves an application module’s relative imports as TypeScript does: an extension added, an index, `.js` read as `.ts`', async () => {
    const directory = await application({
      'lib/names.ts': "export const name: string = 'alice';\n",
      'main.mts': "import { both } from '@/permissions';\nconsole.log(both);\n",
      'permissions/index.ts': [
        "import { name } from '../lib/names.js';",
        "import { role } from './roles';",
        "import { scope } from './scopes';",
        "export const both: string = [role, name, scope].join('+');",
        '',
      ].join('\n'),
      'permissions/roles.ts': "export const role: string = 'editor';\n",
      'permissions/scopes/index.ts': "export const scope: string = 'todos';\n",
    });

    await expect(run(directory)).resolves.toMatchObject({
      code: 0,
      stdout: 'editor+alice+todos\n',
    });
  });

  it('resolves an application JavaScript module’s relative imports as a bundler does, an extension added', async () => {
    const directory = await application({
      'main.mts': "import { name } from '@/permissions';\nconsole.log(name);\n",
      'package.json': '{ "type": "module" }',
      'permissions.js': "export { name } from './policy';\n",
      'policy.js': "export const name = 'policy';\n",
    });

    await expect(run(directory)).resolves.toMatchObject({ code: 0, stdout: 'policy\n' });
  });

  it('takes the TypeScript file a `.js` import names, as TypeScript does, over the JavaScript beside it', async () => {
    const directory = await application({
      'lib/names.js': "export const name = 'compiled long ago';\n",
      'lib/names.ts': "export const name: string = 'as checked';\n",
      'main.mts': "import { name } from '@/permissions';\nconsole.log(name);\n",
      'permissions.ts': "export { name } from './lib/names.js';\n",
    });

    await expect(run(directory)).resolves.toMatchObject({ code: 0, stdout: 'as checked\n' });
  });

  it('tries a TypeScript file before a JavaScript one, as TypeScript does, and refuses its JSX', async () => {
    const directory = await application({
      'main.mts': "import { name } from '@/widget';\nconsole.log(name);\n",
      'widget.js': "export const name = 'compiled long ago';\n",
      'widget.tsx': 'export const name: string = String(<p />);\n',
    });

    const ran = await run(directory);

    expect(ran.code).not.toBe(0);
    expect(ran.stderr).toContain('which Node cannot run');
    expect(ran.stdout).toBe('');
  });

  it('takes the TypeScript file an alias’s `.js` target names, as TypeScript does', async () => {
    const directory = await application(
      {
        'main.mts': "import { name } from '@policy';\nconsole.log(name);\n",
        'policy.ts': "export const name: string = 'policy';\n",
      },
      JSON.stringify({ compilerOptions: { paths: { '@policy': ['./policy.js'] } } }),
    );

    await expect(run(directory)).resolves.toMatchObject({ code: 0, stdout: 'policy\n' });
  });

  it('reads a tsconfig that begins with a byte-order mark, as TypeScript and Next.js do', async () => {
    const directory = await application(
      {
        'db.ts': "export const name: string = 'db';\n",
        'main.mts': "import { name } from '@/db';\nconsole.log(name);\n",
      },
      `\u{FEFF}${JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } })}`,
    );

    await expect(run(directory)).resolves.toMatchObject({ code: 0, stdout: 'db\n' });
  });

  it('loads the JSON an application module imports without an attribute, as TypeScript and the bundlers let it', async () => {
    const directory = await application({
      'limits.json': '{ "most": 3 }',
      'main.mts': "import { both } from '@/permissions';\nconsole.log(both);\n",
      'permissions.ts': [
        "import roles from '@/roles.json';",
        "import limits from './limits.json';",
        "import typed from './limits.json' with { type: 'json' };",
        "export const both: string = [roles.editor, limits.most, typed.most].join('/');",
        '',
      ].join('\n'),
      'roles.json': '{ "editor": "bob" }',
    });

    await expect(run(directory)).resolves.toMatchObject({ code: 0, stdout: 'bob/3/3\n' });
  });

  it('reads such JSON as JSON: a `"__proto__"` key is a property, not a prototype', async () => {
    const directory = await application({
      'main.mts': [
        "import data from '@/data.json';",
        'console.log([',
        "  Object.hasOwn(data, '__proto__'),",
        '  Object.getPrototypeOf(data) === Object.prototype,',
        "  'polluted' in data,",
        '].join(" "));',
        '',
      ].join('\n'),
      'data.json': '\u{FEFF}{ "__proto__": { "polluted": true }, "name": "data" }',
    });

    await expect(run(directory)).resolves.toMatchObject({ code: 0, stdout: 'true true false\n' });
  });

  it('looks a bare specifier no key matches up under `baseUrl`, as TypeScript does', async () => {
    const directory = await application(
      {
        'main.mts': "import { name } from 'permissions';\nconsole.log(name);\n",
        'src/permissions.ts': "export const name: string = 'src/permissions';\n",
      },
      JSON.stringify({ compilerOptions: { baseUrl: './src' } }),
    );

    await expect(run(directory)).resolves.toMatchObject({
      code: 0,
      stdout: 'src/permissions\n',
    });
  });

  it('takes the `.cts` a `.cjs` import names, as TypeScript does', async () => {
    const directory = await application({
      'main.mts': "import { name } from '@/permissions';\nconsole.log(name);\n",
      'permissions.ts':
        "import policy from './policy.cjs';\nexport const name: string = policy.name;\n",
      'policy.cts': "const name: string = 'policy';\nmodule.exports = { name };\n",
    });

    await expect(run(directory)).resolves.toMatchObject({ code: 0, stdout: 'policy\n' });
  });

  it('leaves a package’s imports to the package, though a name of one is a path the application declares', async () => {
    const directory = await application(
      {
        'main.mts': "import { name } from 'dependency';\nconsole.log(name);\n",
        'node_modules/dependency/index.js': "export { name } from 'permissions';\n",
        'node_modules/dependency/package.json': '{ "type": "module", "main": "index.js" }',
        'node_modules/permissions/index.js': "export const name = 'the package';\n",
        'node_modules/permissions/package.json': '{ "type": "module", "main": "index.js" }',
        'src/permissions.ts': "export const name: string = 'the application';\n",
      },
      JSON.stringify({ compilerOptions: { baseUrl: './src' } }),
    );

    await expect(run(directory)).resolves.toMatchObject({ code: 0, stdout: 'the package\n' });
  });

  it('leaves a linked package’s imports to the package, wherever the link leads, though a name of one is a path the application declares', async () => {
    const outside = await elsewhere(DEPENDS_ON_PERMISSIONS);
    const directory = await application(
      {
        'main.mts': [
          "import { name as inside } from 'inside';",
          "import { name as outside } from 'outside';",
          'console.log(inside, outside);',
          '',
        ].join('\n'),
        ...dependencyAt('packages/inside'),
        'src/permissions.ts': "export const name: string = 'the application';\n",
      },
      JSON.stringify({ compilerOptions: { baseUrl: './src' } }),
    );
    // Linked as a workspace's packages are: Node names each by where its link leads.
    await mkdir(path.join(directory, 'node_modules'));
    await symlink('../packages/inside', path.join(directory, 'node_modules/inside'), 'dir');
    await symlink(outside, path.join(directory, 'node_modules/outside'), 'dir');

    await expect(run(directory)).resolves.toMatchObject({
      code: 0,
      stdout: 'the package the package\n',
    });
  });

  it('leaves the imports of a package a `#` import maps to to the package, though a name of one is a path the application declares', async () => {
    const directory = await application(
      {
        'main.mts': "import { name } from '#dep';\nconsole.log(name);\n",
        ...dependencyAt('packages/dependency'),
        'package.json': JSON.stringify({ imports: { '#dep': 'dependency' }, type: 'module' }),
        'src/permissions.ts': "export const name: string = 'the application';\n",
      },
      JSON.stringify({ compilerOptions: { baseUrl: './src' } }),
    );
    // Linked as a workspace's package is: Node names it by where its link leads.
    await mkdir(path.join(directory, 'node_modules'));
    await symlink('../packages/dependency', path.join(directory, 'node_modules/dependency'), 'dir');

    await expect(run(directory)).resolves.toMatchObject({ code: 0, stdout: 'the package\n' });
  });

  it('resolves the aliases of a module an alias leads to outside the application’s directory, as TypeScript does', async () => {
    const shared = await elsewhere({
      'labels.ts':
        "import { prefix } from '@shared/prefix';\nexport const label: string = prefix + ':todo';\n",
      'prefix.ts': "export const prefix: string = 'shared';\n",
    });
    const directory = await application(
      { 'main.mts': "import { label } from '@shared/labels';\nconsole.log(label);\n" },
      JSON.stringify({ compilerOptions: { paths: { '@shared/*': [`${shared}/*`] } } }),
    );

    await expect(run(directory)).resolves.toMatchObject({ code: 0, stdout: 'shared:todo\n' });
  });

  it('resolves the aliases of a module the application imports by a `#` import of its own', async () => {
    const directory = await application({
      'lib/labels.ts':
        "import { name } from '@/permissions';\nexport const label: string = name + ':todo';\n",
      'main.mts': "import { label } from '#lib/labels';\nconsole.log(label);\n",
      'package.json': '{ "type": "module", "imports": { "#lib/*": "./lib/*.ts" } }',
      'permissions.ts': "export const name: string = 'editor';\n",
    });

    await expect(run(directory)).resolves.toMatchObject({ code: 0, stdout: 'editor:todo\n' });
  });

  it('resolves the aliases of the code `-e` runs, which no module imports', async () => {
    const directory = await application({
      'permissions.ts': "export const name: string = 'editor';\n",
    });

    await expect(
      run(directory, [
        '--input-type=module',
        '-e',
        "const { name } = await import('@/permissions'); console.log(name);",
      ]),
    ).resolves.toMatchObject({ code: 0, stdout: 'editor\n' });
  });

  it('keeps a comma before a bracket inside a string of the tsconfig, as JSON does', async () => {
    const directory = await application(
      {
        'main.mts': "import { name } from '@/policy';\nconsole.log(name);\n",
        'policy,}.ts': "export const name: string = 'policy';\n",
      },
      [
        '{',
        '  "compilerOptions": {',
        '    "paths": { "@/policy": ["./policy,}.ts"], },',
        '  },',
        '}',
      ].join('\n'),
    );

    await expect(run(directory)).resolves.toMatchObject({ code: 0, stdout: 'policy\n' });
  });

  it('resolves the aliases a configuration inherits through `extends`, from the one that declares them', async () => {
    const directory = await application(
      {
        'config/base.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['../src/*'] } } }),
        'main.mts': "import { name } from '@/permissions';\nconsole.log(name);\n",
        'src/permissions.ts': "export const name: string = 'inherited';\n",
      },
      JSON.stringify({ extends: './config/base' }),
    );

    await expect(run(directory)).resolves.toMatchObject({ code: 0, stdout: 'inherited\n' });
  });

  it('takes its own `paths` over what it inherits, and the later of what it extends over the earlier', async () => {
    const files = {
      'main.mts': "import { name } from '@/permissions';\nconsole.log(name);\n",
      'one.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./one/*'] } } }),
      'one/permissions.ts': "export const name: string = 'one';\n",
      'own/permissions.ts': "export const name: string = 'own';\n",
      'two.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./two/*'] } } }),
      'two/permissions.ts': "export const name: string = 'two';\n",
    };
    const later = await application(
      files,
      JSON.stringify({ extends: ['./one.json', './two.json'] }),
    );
    const own = await application(
      files,
      JSON.stringify({
        compilerOptions: { paths: { '@/*': ['./own/*'] } },
        extends: ['./one.json', './two.json'],
      }),
    );

    await expect(run(later)).resolves.toMatchObject({ code: 0, stdout: 'two\n' });
    await expect(run(own)).resolves.toMatchObject({ code: 0, stdout: 'own\n' });
  });

  it('reads the `configDir` placeholder of a package’s configuration as the directory of the one in use', async () => {
    const directory = await application(
      {
        'main.mts': "import { name } from '@/permissions';\nconsole.log(name);\n",
        'node_modules/shared-config/index.js': 'export {};\n',
        'node_modules/shared-config/package.json':
          '{ "name": "shared-config", "type": "module", "main": "index.js" }',
        'node_modules/shared-config/tsconfig.json': JSON.stringify({
          compilerOptions: { paths: { '@/*': [`\${configDir}/src/*`] } },
        }),
        'src/permissions.ts': "export const name: string = 'the application';\n",
      },
      JSON.stringify({ extends: 'shared-config' }),
    );

    await expect(run(directory)).resolves.toMatchObject({
      code: 0,
      stdout: 'the application\n',
    });
  });

  it('reads the configuration a package names in its `package.json`, as TypeScript does', async () => {
    const directory = await application(
      {
        'main.mts': "import { name } from '@/permissions';\nconsole.log(name);\n",
        'node_modules/@company/config/configs/strict.json': JSON.stringify({
          compilerOptions: { paths: { '@/*': [`\${configDir}/src/*`] } },
        }),
        'node_modules/@company/config/index.js': 'export {};\n',
        'node_modules/@company/config/package.json': JSON.stringify({
          exports: { '.': './index.js' },
          name: '@company/config',
          tsconfig: './configs/strict.json',
          type: 'module',
        }),
        'src/permissions.ts': "export const name: string = 'named';\n",
      },
      JSON.stringify({ extends: '@company/config' }),
    );

    await expect(run(directory)).resolves.toMatchObject({ code: 0, stdout: 'named\n' });
  });

  it('takes the entry a directory an alias names declares in its `package.json`, as TypeScript does', async () => {
    const directory = await application(
      {
        'main.mts': "import { name } from 'policy';\nconsole.log(name);\n",
        'policy/package.json': JSON.stringify({ main: './src/index.js' }),
        'policy/src/index.ts': "export const name: string = 'the entry';\n",
      },
      JSON.stringify({ compilerOptions: { paths: { policy: ['./policy'] } } }),
    );

    await expect(run(directory)).resolves.toMatchObject({ code: 0, stdout: 'the entry\n' });
  });

  it('takes the file a package of no `exports` holds at a subpath named without its extension, as the bundlers do', async () => {
    const directory = await application({
      'main.mts': "import { name } from 'legacy/feature';\nconsole.log(name);\n",
      'node_modules/legacy/feature.js': "export const name = 'feature';\n",
      'node_modules/legacy/package.json': '{ "name": "legacy", "type": "module" }',
    });

    await expect(run(directory)).resolves.toMatchObject({ code: 0, stdout: 'feature\n' });
  });

  it('takes the entry of a directory a package of no `exports` holds at a subpath, as the bundlers do', async () => {
    const directory = await application({
      'main.mts': "import { name } from 'legacy/feature';\nconsole.log(name);\n",
      'node_modules/legacy/feature/index.js': "export const name = 'a directory';\n",
      'node_modules/legacy/package.json': '{ "name": "legacy", "type": "module" }',
    });

    await expect(run(directory)).resolves.toMatchObject({ code: 0, stdout: 'a directory\n' });
  });

  it('takes a package whose `exports` is `null` for one of none at a subpath named without its extension, as Node does', async () => {
    const directory = await application({
      'main.mts': "import { name } from 'legacy/feature';\nconsole.log(name);\n",
      'node_modules/legacy/feature.js': "export const name = 'no exports';\n",
      'node_modules/legacy/package.json': '{ "exports": null, "name": "legacy", "type": "module" }',
    });

    await expect(run(directory)).resolves.toMatchObject({ code: 0, stdout: 'no exports\n' });
  });

  it('imports a JSON document a package exports without an attribute, as the bundlers do, and lets a package require one', async () => {
    const directory = await application({
      'main.mts':
        "import data, { name } from 'exported/data';\nimport required from 'required';\nconsole.log(name, data.name, required);\n",
      'node_modules/exported/data.json': '{ "name": "exported" }',
      'node_modules/exported/package.json': JSON.stringify({
        exports: { './data': './data.json' },
        name: 'exported',
        type: 'module',
      }),
      'node_modules/required/data.json': '{ "name": "required" }',
      'node_modules/required/index.js': "module.exports = require('./data.json').name;\n",
      'node_modules/required/package.json': '{ "main": "./index.js", "name": "required" }',
    });

    await expect(run(directory)).resolves.toMatchObject({
      code: 0,
      stdout: 'exported exported required\n',
    });
  });

  it('exports each key of a JSON document imported without an attribute by its own name, as the bundlers do', async () => {
    const directory = await application({
      'main.mts':
        "import policy, { roles } from '@/policy.json';\nconsole.log(roles.join(','), policy.roles.length);\n",
      'policy.json': '{ "roles": ["editor", "owner"], "default": "not a name" }',
    });

    await expect(run(directory)).resolves.toMatchObject({ code: 0, stdout: 'editor,owner 2\n' });
  });

  it('resolves the aliases of the application’s modules it imports by its own name', async () => {
    const directory = await application(
      {
        'main.mts': "import { name } from 'self-app';\nconsole.log(name);\n",
        'package.json': JSON.stringify({
          exports: { '.': './src/index.ts' },
          name: 'self-app',
          type: 'module',
        }),
        'src/index.ts': "export { name } from '@/permissions';\n",
        'src/permissions.ts': "export const name: string = 'its own';\n",
      },
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
    );

    await expect(run(directory)).resolves.toMatchObject({ code: 0, stdout: 'its own\n' });
  });

  it('loads a `.ts` module as its package’s `type` makes it, CommonJS too, as Node does', async () => {
    const directory = await application({
      'main.mts': "import permissions from '@/permissions';\nconsole.log(permissions.name);\n",
      'package.json': '{ "type": "commonjs" }',
      'permissions.ts': "module.exports = { name: 'commonjs' };\n",
    });

    await expect(run(directory)).resolves.toMatchObject({ code: 0, stdout: 'commonjs\n' });
  });

  it('matches a key without `*` as itself alone, as TypeScript does, not as a prefix', async () => {
    const directory = await application(
      {
        'config/extra.ts': "export const name: string = 'extra';\n",
        'config/index.ts': "export const name: string = 'index';\n",
        'main.mts': [
          "import { name } from '@config';",
          'console.log(name);',
          "await import('@config/extra').then(",
          "  () => { console.log('resolved'); },",
          '  (error) => { console.log(error.code); },',
          ');',
          '',
        ].join('\n'),
      },
      JSON.stringify({ compilerOptions: { paths: { '@config': ['./config'] } } }),
    );

    await expect(run(directory)).resolves.toMatchObject({
      code: 0,
      stdout: 'index\nERR_MODULE_NOT_FOUND\n',
    });
  });

  it('takes the matching key with the longest text before its `*`, as TypeScript does', async () => {
    const directory = await application(
      {
        'lib/x.ts': "export const name: string = 'lib';\n",
        'main.mts': "import { name } from '@/lib/x';\nconsole.log(name);\n",
        'src/lib/x.ts': "export const name: string = 'src/lib';\n",
      },
      JSON.stringify({
        compilerOptions: { paths: { '@/*': ['./*'], '@/lib/*': ['./src/lib/*'] } },
      }),
    );

    await expect(run(directory)).resolves.toMatchObject({ code: 0, stdout: 'src/lib\n' });
  });

  it('resolves an alias from `baseUrl` where the tsconfig sets one, as TypeScript and the bundlers do', async () => {
    const directory = await application(
      {
        'main.mts': "import { name } from '@/db';\nconsole.log(name);\n",
        'src/app/db.ts': "export const name: string = 'src/app/db';\n",
      },
      JSON.stringify({ compilerOptions: { baseUrl: './src', paths: { '@/*': ['app/*'] } } }),
    );

    await expect(run(directory)).resolves.toMatchObject({ code: 0, stdout: 'src/app/db\n' });
  });

  it('loads a TypeScript module, and a directory’s index, by the alias the tsconfig declares', async () => {
    const directory = await application({
      'db.ts': "export const name: string = 'db';\n",
      'lib/index.ts': "import { name } from '@/db';\nexport const both = name + '+lib';\n",
      'main.mts': "import { both } from '@/lib';\nconsole.log(both);\n",
    });

    const ran = await run(directory);

    expect(ran).toMatchObject({ code: 0, stdout: 'db+lib\n' });
    // Loaded as TypeScript, whatever a missing `package.json` would have had Node guess.
    expect(ran.stderr).not.toContain('MODULE_TYPELESS_PACKAGE_JSON');
  });

  it('refuses a module of JSX by name, rather than as one not found', async () => {
    const directory = await application({
      'main.mts': "await import('@/ui');\n",
      'ui.tsx': 'export const Button = () => <button />;\n',
    });

    const ran = await run(directory);

    expect(ran.code).not.toBe(0);
    expect(ran.stderr).toContain('which Node cannot run');
  });

  it('leaves a specifier no alias matches, and an alias that names no file, to Node', async () => {
    const directory = await application({
      'main.mts': "try { await import('@/missing'); } catch (error) { console.log(error.code); }\n",
    });

    const ran = await run(directory);

    expect(ran.stdout).toBe('ERR_MODULE_NOT_FOUND\n');
  });
});
