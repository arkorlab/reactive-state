import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeAuthorityModule } from '../src/next/authority-module.ts';
import { compileProject } from '../src/next/compile-on-build.ts';

/**
 * The module a host imports the authority's object from is never one the compile owns: the `out`
 * holds what the compile writes, replaces a file of it that it writes, and removes one it no longer
 * writes. A module written there would replace the application's registry (`authority.mts`), which
 * the object imports, with a re-export of the object.
 */

const VARIABLE = 'REACTIVE_AUTHORITY_MODULE';
const REGISTRY = 'generated/authority.mts';
const HELLO = [
  'export default function Hello({ name }: { readonly name: string }) {',
  '  return <p>Hello, {name}</p>;',
  '}',
  '',
].join('\n');

const projects: string[] = [];

/** An application of one component, as a build compiles it. */
function application(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'reactive-state-authority-out-'));
  projects.push(dir);
  const files = {
    'src/app/page.tsx': 'export default function Page() {\n  return null;\n}\n',
    'src/components/hello.reactive.tsx': HELLO,
    'tsconfig.json': JSON.stringify({
      compilerOptions: { jsx: 'react-jsx', paths: { '@/*': ['./src/*'] } },
    }),
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

describe('a module the host imports the authority’s object from, inside the `out` of the compile', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of projects.splice(0)) rmSync(dir, { force: true, recursive: true });
  });

  it('is refused where it names the registry the compile writes, which stays as compiled', async () => {
    const dir = application();
    vi.stubEnv(VARIABLE, REGISTRY);

    await expect(compileProject({ out: 'generated', projectDir: dir })).rejects.toThrow(
      /inside its `out`/u,
    );

    const registry = readFileSync(path.join(dir, REGISTRY), 'utf8');

    expect(registry).toContain('export const programs = [program$components$hello];');
    expect(registry).not.toContain('export { ReactiveAuthority }');
  });

  it('is refused of any name inside it, which the next compile would remove as one it does not write', () => {
    const dir = application();

    expect(() => {
      return writeAuthorityModule(
        { outDir: path.join(dir, 'generated'), projectDir: dir },
        { [VARIABLE]: 'generated/nested/host.mjs' },
      );
    }).toThrow(/inside its `out`/u);
  });

  it('is left as it is where it names the object the compile writes there itself', async () => {
    const dir = application();
    vi.stubEnv(VARIABLE, 'generated/durable-object.mjs');

    await compileProject({ out: 'generated', projectDir: dir });

    expect(readFileSync(path.join(dir, 'generated/durable-object.mjs'), 'utf8')).toContain(
      'export const ReactiveAuthority = authorityObject(application);',
    );
  });
});
