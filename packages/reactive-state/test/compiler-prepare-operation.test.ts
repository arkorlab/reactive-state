import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { type Compiled, compileApp, openTypeScript } from '../src/compiler/index.ts';
import { loaderOptions, projectOfLoader, withReactiveState } from '../src/next/config.ts';
import { application, type Application, cli, output, removed } from './fixtures/application.ts';

/**
 * How the application names its preparation of an operation: the compile's `--prepare-operation`
 * and `withReactiveState`'s `prepareOperation`. The compile re-exports it beside the session source
 * and the change applier, and hands it to each stub's `operate`.
 */

// A whole compile of the fixture runs well past vitest's five seconds on a loaded machine.
vi.setConfig({ hookTimeout: 300_000, testTimeout: 300_000 });

interface Compile {
  readonly app: Application;
  readonly result: Compiled;
}

/** The text of the first `'use server'` module's stub the compile wrote. */
function actionOf({ app, result }: Compile): string {
  for (const [file, text] of result.outputs) {
    if (path.relative(app.out, file).startsWith('actions')) {
      return text;
    }
  }
  throw new Error('The compile wrote no stub.');
}

/** The re-export the command line wrote, or nothing where it wrote none. */
async function written(app: Application): Promise<string> {
  try {
    return await readFile(path.join(app.out, 'request-session.ts'), 'utf8');
  } catch {
    return '';
  }
}

describe('the preparation of an operation', () => {
  let api: API;
  const apps: Application[] = [];
  let all: Compile;
  let alone: Compile;
  let none: Compile;
  let ran: { readonly status: number | null; readonly written: string };

  async function compiled(options: {
    readonly session?: string;
    readonly sessionChange?: string;
    readonly prepareOperation?: string;
  }): Promise<Compile> {
    const app = await application();
    apps.push(app);
    return {
      app,
      result: compileApp({ api, appDir: app.appDir, outDir: app.out, srcDir: app.src, ...options }),
    };
  }

  beforeAll(async () => {
    api = openTypeScript();
    all = await compiled({
      prepareOperation: '@/session#prepareOperation',
      session: '@/session#appSession',
      sessionChange: '@/session#applySessionChange',
    });
    alone = await compiled({ prepareOperation: '@/session#prepareOperation' });
    none = await compiled({ session: '@/session#appSession' });
    const app = await application();
    apps.push(app);
    const run = cli(
      app.src,
      '--out',
      app.out,
      '--app',
      app.appDir,
      '--prepare-operation',
      '@/session#prepareOperation',
    );
    ran = { status: run.status, written: await written(app) };
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    for (const app of apps.splice(0)) {
      await removed(app);
    }
  });

  it('is re-exported beside the session source and the change applier', () => {
    expect(all.result.refusals).toStrictEqual([]);

    const reexport = output(all.result, all.app, 'request-session.ts');

    expect(reexport).toContain('export { appSession as session } from "@/session";');
    expect(reexport).toContain('export { applySessionChange as sessionChange } from "@/session";');
    expect(reexport).toContain('export { prepareOperation as prepareOperation } from "@/session";');
  });

  it('is handed to each stub’s operate, beside the others', () => {
    const stub = actionOf(all);

    expect(stub).toContain(
      "import { prepareOperation as prepareOperation$ } from '../request-session';",
    );
    expect(stub).toContain(
      'session: session$, sessionChange: sessionChange$, prepareOperation: prepareOperation$ }) as Promise',
    );
  });

  it('works named alone', () => {
    expect(alone.result.refusals).toStrictEqual([]);

    const stub = actionOf(alone);
    const reexport = output(alone.result, alone.app, 'request-session.ts');

    expect(reexport).not.toContain('as session }');
    expect(reexport).not.toContain('as sessionChange }');
    expect(reexport).toContain('export { prepareOperation as prepareOperation } from "@/session";');
    expect(stub).toContain('{ build: ');
    expect(stub).toContain(', prepareOperation: prepareOperation$ }) as Promise');
    expect(stub).not.toContain('session$');
  });

  it('adds nothing to a stub where none is named', () => {
    const stub = actionOf(none);

    expect(stub).not.toContain('prepareOperation');
    expect(output(none.result, none.app, 'request-session.ts')).not.toContain('prepareOperation');
  });

  it('is named by the command line’s --prepare-operation', () => {
    expect(ran.status).toBe(0);
    expect(ran.written).toContain(
      'export { prepareOperation as prepareOperation } from "@/session";',
    );
  });

  it('is refused where it names no export', () => {
    const result = compileApp({
      api,
      appDir: 'app',
      outDir: '.reactive',
      prepareOperation: '@/session',
      srcDir: 'src',
    });

    expect(result.refusals.map((refusal) => refusal.message)).toStrictEqual([
      expect.stringContaining('names no operation preparation'),
    ]);
    expect(result.refusals[0]?.message).toContain('@/session#prepareOperation');
  });

  it('is an option of withReactiveState, handed to the compile', () => {
    const options = { prepareOperation: '@/reactive/session#prepareOperation' };

    expect(loaderOptions(options)).toMatchObject(options);
    expect(projectOfLoader(loaderOptions(options))).toMatchObject(options);
    expect(withReactiveState({}, options)).toBeDefined();
  });
});
