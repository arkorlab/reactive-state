import path from 'node:path';

import { type AppInput, type CompiledComponent, emitStub, relativeSpecifier } from './emit-app.ts';
import { header } from './emit-authority.ts';
import {
  emitRequestSession,
  type HostOptions,
  type Named,
  namedOf,
  type PrefetchLife,
  prefetchCacheOf,
  prefetchOf,
  REQUEST_SESSION,
} from './emit-host.ts';
import { ReactiveCompileError } from './errors.ts';

/**
 * What the host's options (`HostOptions`) make of the compile beyond what each output writes of
 * them: the options read, each refused where it names nothing; which root a private cache keeps, and
 * which the deployment's; and the stubs that hand the application's session source on.
 */

/** What the host tells the compile, as the compile's options carry it. */
export interface HostInput {
  /** The module and the export its own sessions are read by (`--session`), where it has one. */
  readonly session?: string;
  /** The module and the export that applies a session change an operation asks for. */
  readonly sessionChange?: string;
  /** The private cache its roots render inside for a link's prefetch (`--prefetch`), where said. */
  readonly prefetch?: string;
  /** Where those roots are kept, `private` or `remote` (`--prefetch-cache`), where said. */
  readonly prefetchCache?: string;
  /** `false` where it shares nothing (`--no-share`). */
  readonly share?: boolean;
}

/**
 * The options a host was given — by its command line, by its build — as the compile takes them: each
 * one given, and none of those it was not.
 */
export function givenHost(given: {
  readonly database?: string | undefined;
  readonly session?: string | undefined;
  readonly sessionChange?: string | undefined;
  readonly prefetch?: string | undefined;
  readonly prefetchCache?: string | undefined;
  readonly share?: boolean | undefined;
}): HostInput & { readonly database?: string } {
  const { database, prefetch, prefetchCache, session, sessionChange, share } = given;
  return {
    ...(database !== undefined && { database }),
    ...(session !== undefined && { session }),
    ...(sessionChange !== undefined && { sessionChange }),
    ...(prefetch !== undefined && { prefetch }),
    ...(prefetchCache !== undefined && { prefetchCache }),
    ...(share === false && { share: false }),
  };
}

/**
 * The host options a compile's digest reads in one list, in the order it has always held them: what
 * the digest says of where the roots a prefetch carries are kept it says beside this list, where
 * said alone, so that a project that says nothing of it digests as it did before.
 */
export function hostDigest(options: HostInput): readonly (boolean | string | undefined)[] {
  return [options.session, options.prefetch, options.share, options.sessionChange];
}

/**
 * What the host tells the compile beside the sources (`HostOptions`): the session source and the
 * prefetch's lifetime it names, each refused where it names none, and where the roots a prefetch
 * carries are kept, refused where they cannot be.
 */
export function hostOf(options: HostInput): HostOptions {
  const session = namedBy(options.session, '--session', 'session source', '@/session#session');
  const sessionChange = namedBy(
    options.sessionChange,
    '--session-change',
    'session-change applier',
    '@/session#applySessionChange',
  );
  const prefetch = options.prefetch === undefined ? undefined : prefetchOf(options.prefetch);
  const prefetchCache = prefetchCacheOf(options.prefetchCache, { prefetch, session });
  return {
    prefetch,
    session,
    sessionChange,
    ...(prefetchCache !== undefined && { prefetchCache }),
    ...(options.share === false && { share: false }),
  };
}

/** `written` as the module and export it names, or the refusal of option `flag`, which names `what`. */
function namedBy(
  written: string | undefined,
  flag: string,
  what: string,
  example: string,
): Named | undefined {
  const named = written === undefined ? undefined : namedOf(written);
  if (named === undefined && written !== undefined) {
    throw new ReactiveCompileError(
      `\`${written}\` names no ${what}: it is \`<specifier>#<export>\`, as \`${example}\`.`,
      { fileName: flag, position: { character: 0, line: 0 } },
    );
  }
  return named;
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
 * Whether `root` renders a persistent state — a field of the database, which a page writes through
 * `update` — of its own or of a component it renders, however deep, of `components`, by their ids.
 */
function holdsFields(
  root: CompiledComponent,
  components: ReadonlyMap<string, CompiledComponent>,
): boolean {
  const seen = new Set([root.component.id]);
  const pending = [root];
  let compiled = pending.pop();
  while (compiled !== undefined) {
    if (compiled.sides.evaluated.some((state) => !state.local)) {
      return true;
    }
    for (const id of compiled.sides.refs.components.values()) {
      const rendered = components.get(id);
      if (rendered !== undefined && !seen.has(id)) {
        seen.add(id);
        pending.push(rendered);
      }
    }
    compiled = pending.pop();
  }
  return false;
}

/**
 * Of a build whose roots the deployment's cache keeps (`--prefetch-cache remote`), whether it keeps
 * `root`'s render — of a root the private cache keeps for a prefetch (`life`): not that of a root
 * its route registers, which reads the request's headers, as nothing inside `'use cache: remote'`
 * may; nor that of a root of a persistent state (`holdsFields`), whose write through `update`
 * expires nothing — an expiry at once from a Server Function has the route rendered again in its
 * answer, at every keystroke — so that a reload would show the write undone: those stay private.
 * Nothing of another build.
 */
export function rootRemote(
  host: HostOptions | undefined,
  root: {
    readonly compiled: CompiledComponent;
    readonly life: PrefetchLife | undefined;
    readonly route: string | undefined;
  },
  components: ReadonlyMap<string, CompiledComponent>,
): { readonly kept: boolean } | undefined {
  if (host?.prefetchCache !== 'remote') {
    return undefined;
  }
  const { compiled, life, route } = root;
  return { kept: life !== undefined && route === undefined && !holdsFields(compiled, components) };
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
      `The compile writes the session source's re-export as \`${REQUEST_SESSION}\`, where this module's would be written (\`--session\`, \`--session-change\`): name the module otherwise.`,
      { fileName: taken.fileName, position: { character: 0, line: 0 } },
    );
  }
}

/**
 * The stub of each `'use server'` module, handed the application's session source where it signs
 * its users in itself — and told whether the build keeps its roots in the deployment's cache, whose
 * session's an operation that succeeded expires — and that source's re-export beside the elements
 * (`<out>/request-session.ts`).
 */
export function emitStubs(
  app: AppInput,
  outDir: string,
  put: (file: string, text: string) => void,
): void {
  const session = app.host?.session;
  const sessionChange = app.host?.sessionChange;
  const named = session !== undefined || sessionChange !== undefined;
  if (named) {
    refuseOutputTaken(app);
  }
  for (const operation of app.operations) {
    const stub = path.join(outDir, `${operation.id}.ts`);
    const from = relativeSpecifier(stub, path.join(outDir, REQUEST_SESSION));
    put(
      stub,
      emitStub(
        operation,
        app.buildId,
        named
          ? {
              from,
              kept: app.host?.prefetchCache === 'remote',
              session: session !== undefined,
              sessionChange: sessionChange !== undefined,
            }
          : undefined,
      ),
    );
  }
  if (named) {
    put(
      path.join(outDir, `${REQUEST_SESSION}.ts`),
      emitRequestSession(
        { session, sessionChange },
        header("the application's components", 'components'),
      ),
    );
  }
}
