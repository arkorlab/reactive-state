import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it, onTestFinished } from 'vitest';

/**
 * The attributes an import of a JSON document names, under `registerPaths`: none, and the hooks
 * load it as a module whose default it is, as TypeScript and the bundlers let an application write
 * it; `type: 'json'`, and Node loads it; any other, and Node refuses it, as it refuses it of a JSON
 * document it loads without the hooks — and as the bundler of a Durable Object does. Each case runs
 * in a Node of its own, as `paths.test.ts`'s do.
 */

const PATHS = fileURLToPath(new URL('../src/authority/paths.ts', import.meta.url));

interface Ran {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

/** An application of `files`, whose `tsconfig.json` aliases `@/*` to its root. */
async function application(files: Readonly<Record<string, string>>): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'reactive-paths-attributes-'));
  onTestFinished(async () => {
    await rm(directory, { force: true, recursive: true });
  });
  const tsconfig = path.join(directory, 'tsconfig.json');
  await writeFile(tsconfig, JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }));
  await writeFile(
    path.join(directory, 'register.mts'),
    `import { registerPaths } from ${JSON.stringify(PATHS)};\nregisterPaths(${JSON.stringify(tsconfig)});\n`,
  );
  for (const [name, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), source);
  }
  return directory;
}

/** `main.mts` of the application, in a Node that registered its aliases first. */
async function run(directory: string): Promise<Ran> {
  try {
    const { stderr, stdout } = await promisify(execFile)(
      process.execPath,
      ['--import', './register.mts', 'main.mts'],
      { cwd: directory },
    );
    return { code: 0, stderr, stdout };
  } catch (error) {
    const failed = error as {
      readonly code?: number;
      readonly stderr?: string;
      readonly stdout?: string;
    };
    return { code: failed.code ?? 1, stderr: failed.stderr ?? '', stdout: failed.stdout ?? '' };
  }
}

/** Each import `main.mts` makes, by its name, and the attributes it names. */
const IMPORTS = [
  ['relative css', './relative.json', { type: 'css' }],
  ['aliased css', '@/aliased.json', { type: 'css' }],
  ['exported css', 'exported/data', { type: 'css' }],
  ['implicit type', './javascript.json', { type: 'javascript' }],
  ['another key', './keyed.json', { mode: 'strict' }],
  ['none', './none.json', {}],
  ['json', './json.json', { type: 'json' }],
] as const;

/** A document for each import, each a file of its own: Node keeps a module by its URL. */
const DOCUMENTS = {
  'aliased.json': '{ "name": "aliased" }',
  'javascript.json': '{ "name": "javascript" }',
  'json.json': '{ "name": "json" }',
  'keyed.json': '{ "name": "keyed" }',
  'node_modules/exported/data.json': '{ "name": "exported" }',
  'node_modules/exported/package.json': JSON.stringify({
    exports: { './data': './data.json' },
    name: 'exported',
    type: 'module',
  }),
  'none.json': '{ "name": "none" }',
  'relative.json': '{ "name": "relative" }',
} as const;

describe('the attributes an import of a JSON document names', () => {
  it('loads it where they are none or `type: json`, and has Node refuse any other', async () => {
    const directory = await application({
      ...DOCUMENTS,
      'main.mts': [
        `for (const [name, specifier, attributes] of ${JSON.stringify(IMPORTS)}) {`,
        '  const answer = await import(specifier, { with: attributes }).then(',
        "    (module) => 'loaded ' + module.default.name,",
        '    (error) => error.code,',
        '  );',
        "  console.log(name + ': ' + answer);",
        '}',
        '',
      ].join('\n'),
    });

    await expect(run(directory)).resolves.toMatchObject({
      code: 0,
      stdout: [
        'relative css: ERR_IMPORT_ATTRIBUTE_UNSUPPORTED',
        'aliased css: ERR_IMPORT_ATTRIBUTE_UNSUPPORTED',
        'exported css: ERR_IMPORT_ATTRIBUTE_UNSUPPORTED',
        'implicit type: ERR_IMPORT_ATTRIBUTE_UNSUPPORTED',
        'another key: ERR_IMPORT_ATTRIBUTE_UNSUPPORTED',
        'none: loaded none',
        'json: loaded json',
        '',
      ].join('\n'),
    });
  });
});
