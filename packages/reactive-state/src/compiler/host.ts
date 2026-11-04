import path from 'node:path';

import { type AppInput, emitStub, relativeSpecifier } from './emit-app.ts';
import { header } from './emit-authority.ts';
import {
  emitRequestSession,
  type HostOptions,
  namedOf,
  type PrefetchLife,
  prefetchOf,
  REQUEST_SESSION,
} from './emit-host.ts';
import { ReactiveCompileError } from './errors.ts';

/**
 * What the host's options (`HostOptions`) make of the compile beyond what each output writes of
 * them: the options read, each refused where it names nothing; which root a private cache keeps; and
 * the stubs that hand the application's session source on.
 */

/** What the host tells the compile, as the compile's options carry it. */
export interface HostInput {
  readonly session?: string;
  readonly prefetch?: string;
  readonly share?: boolean;
}

/**
 * The options a host was given — by its command line, by its build — as the compile takes them: each
 * one given, and none of those it was not.
 */
export function givenHost(given: {
  readonly database?: string | undefined;
  readonly session?: string | undefined;
  readonly prefetch?: string | undefined;
  readonly share?: boolean | undefined;
}): HostInput & { readonly database?: string } {
  const { database, prefetch, session, share } = given;
  return {
    ...(database !== undefined && { database }),
    ...(session !== undefined && { session }),
    ...(prefetch !== undefined && { prefetch }),
    ...(share === false && { share: false }),
  };
}

/**
 * What the host tells the compile beside the sources (`HostOptions`): the session source and the
 * prefetch's lifetime it names, each refused where it names none.
 */
export function hostOf(options: HostInput): HostOptions {
  const written = options.session;
  const session = written === undefined ? undefined : namedOf(written);
  if (session === undefined && written !== undefined) {
    throw new ReactiveCompileError(
      `\`${written}\` names no session source: it is \`<specifier>#<export>\`, as \`@/session#session\`.`,
      { fileName: '--session', position: { character: 0, line: 0 } },
    );
  }
  const prefetch = options.prefetch === undefined ? undefined : prefetchOf(options.prefetch);
  return { prefetch, session, ...(options.share === false && { share: false }) };
}

/**
 * The private cache a root's entry renders it inside, of the host's prefetch: none for the root of
 * a route every visitor shares — the request alone renders the root it caches.
 */
export function rootPrefetch(
  host: HostOptions | undefined,
  {
    route,
    sharedRoute,
  }: { readonly route?: string | undefined; readonly sharedRoute?: boolean | undefined },
): PrefetchLife | undefined {
  const shared = route !== undefined && sharedRoute !== false;
  return shared ? undefined : host?.prefetch;
}

/**
 * Refuses a module of the application's that the compile would write where it writes the session
 * source's re-export (`<out>/request-session.ts`): a `'use server'` module's stub, or a hook
 * module's copy, of `<src>/request-session.ts`.
 */
function refuseOutputTaken(app: AppInput): void {
  const taken = [
    ...app.operations.map((operation) => ({ fileName: operation.fileName, id: operation.id })),
    ...app.hooks.map((hooks) => ({ fileName: hooks.fileName, id: hooks.id })),
  ].find((module) => module.id === REQUEST_SESSION);
  if (taken !== undefined) {
    throw new ReactiveCompileError(
      `The compile writes the session source's re-export as \`${REQUEST_SESSION}\`, where this module's would be written (\`--session\`): name the module otherwise.`,
      { fileName: taken.fileName, position: { character: 0, line: 0 } },
    );
  }
}

/**
 * The stub of each `'use server'` module, handed the application's session source where it signs
 * its users in itself, and that source's re-export beside the elements (`<out>/request-session.ts`).
 */
export function emitStubs(
  app: AppInput,
  outDir: string,
  put: (file: string, text: string) => void,
): void {
  const session = app.host?.session;
  if (session !== undefined) {
    refuseOutputTaken(app);
  }
  for (const operation of app.operations) {
    const stub = path.join(outDir, `${operation.id}.ts`);
    const from =
      session === undefined
        ? undefined
        : relativeSpecifier(stub, path.join(outDir, REQUEST_SESSION));
    put(stub, emitStub(operation, app.buildId, from));
  }
  if (session !== undefined) {
    put(
      path.join(outDir, `${REQUEST_SESSION}.ts`),
      emitRequestSession(session, header("the application's components", 'components')),
    );
  }
}
