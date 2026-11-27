import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { type Compiled, compileApp, openTypeScript } from '../src/compiler/index.ts';
import { loaderOptions, projectOfLoader, withReactiveState } from '../src/next/config.ts';
import { application, type Application, cli, output, removed } from './fixtures/application.ts';

/**
 * How the application names its applier of the session change an operation asks for: the compile's
 * `--session-change` and `withReactiveState`'s `sessionChange`. The compile re-exports it beside the
 * session source and hands it to each stub's `operate`.
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

describe('the applier of a session change', () => {
  let api: API;
  const apps: Application[] = [];
  let both: Compile;
  let alone: Compile;
  let ran: { readonly status: number | null; readonly written: string };

  async function compiled(options: {
    readonly session?: string;
    readonly sessionChange?: string;
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
    both = await compiled({
      session: '@/session#appSession',
      sessionChange: '@/session#applySessionChange',
    });
    alone = await compiled({ sessionChange: '@/session#applySessionChange' });
    const app = await application();
    apps.push(app);
    const run = cli(
      app.src,
      '--out',
      app.out,
      '--app',
      app.appDir,
      '--session-change',
      '@/session#applySessionChange',
    );
    ran = {
      status: run.status,
      written: await written(app),
    };
  });

  afterAll(async () => {
    api[Symbol.dispose]();
    for (const app of apps.splice(0)) {
      await removed(app);
    }
  });

  it('is re-exported beside the session source', () => {
    expect(both.result.refusals).toStrictEqual([]);

    const reexport = output(both.result, both.app, 'request-session.ts');

    expect(reexport).toContain('export { appSession as session } from "@/session";');
    expect(reexport).toContain('export { applySessionChange as sessionChange } from "@/session";');
  });

  it('is handed to each stub’s operate, beside the session source', () => {
    const stub = actionOf(both);

    expect(stub).toContain("import { session as session$ } from '../request-session';");
    expect(stub).toContain("import { sessionChange as sessionChange$ } from '../request-session';");
    expect(stub).toContain('session: session$, sessionChange: sessionChange$ }) as Promise');
  });

  it('is re-exported and handed on where the application has no session source of its own', () => {
    expect(alone.result.refusals).toStrictEqual([]);

    const stub = actionOf(alone);

    expect(output(alone.result, alone.app, 'request-session.ts')).not.toContain('as session }');
    expect(output(alone.result, alone.app, 'request-session.ts')).toContain(
      'export { applySessionChange as sessionChange } from "@/session";',
    );
    expect(stub).not.toContain('session$ }');
    expect(stub).toContain('{ build: ');
    expect(stub).toContain(', sessionChange: sessionChange$ }) as Promise');
    expect(output(alone.result, alone.app, 'authority.mts')).not.toContain('sessions');
  });

  it('is named by the command line’s --session-change', () => {
    expect(ran.status).toBe(0);
    expect(ran.written).toContain(
      'export { applySessionChange as sessionChange } from "@/session";',
    );
  });

  it('is refused where it names no export', () => {
    const result = compileApp({
      api,
      appDir: 'app',
      outDir: '.reactive',
      sessionChange: '@/session',
      srcDir: 'src',
    });

    expect(result.refusals.map((refusal) => refusal.message)).toStrictEqual([
      expect.stringContaining('names no session-change applier'),
    ]);
  });

  it('is an option of withReactiveState, handed to the compile', () => {
    const options = { sessionChange: '@/reactive/session#applySessionChange' };

    expect(loaderOptions(options)).toMatchObject(options);
    expect(projectOfLoader(loaderOptions(options))).toMatchObject(options);
    expect(withReactiveState({}, options)).toBeDefined();
  });
});
