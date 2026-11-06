import type { MiddlewareRegistration, RegisteredRoute } from '../routing.ts';

/**
 * What a compile writes beside its outputs (`manifest.json`), for whoever reads the build — a script
 * that looks an update up by what it does, a reviewer — and nothing that runs.
 */
export interface Manifest {
  readonly protocol: number;
  readonly buildId: string;
  /** Each component, by id: what the authority evaluates for it and what a write may run. */
  readonly components: Readonly<Record<string, ComponentManifest>>;
  /** Each module of custom hooks the compile copied, by id, with the hooks it exports. */
  readonly hooks: Readonly<
    Record<string, { readonly source: string; readonly hooks: readonly string[] }>
  >;
  /** Each `'use server'` module the authority registers, by id, with the functions it exports. */
  readonly operations: Readonly<
    Record<string, { readonly source: string; readonly exports: readonly string[] }>
  >;
  /** What each module the components and the hooks import is to the compile, by specifier. */
  readonly modules: Readonly<Record<string, string>>;
  /** The elements the host renders by reference: `<specifier>#<export>`. */
  readonly elements: readonly string[];
  /** The application's database: `<specifier>#<export>`. */
  readonly database: string;
  readonly limitations: readonly string[];
  /**
   * The pages that render a reactive root of their route's params, and the other pages and route
   * handlers under route middleware (`PlainRouteRegistration`), by route.
   */
  readonly routes: readonly RegisteredRoute[];
  /** Each route middleware of the app directory, by id. */
  readonly middleware: readonly MiddlewareRegistration[];
}

export interface ComponentManifest {
  readonly source: string;
  readonly name: string;
  /** Whether it has state, and so a Client Component. */
  readonly client: boolean;
  /** The keys of the states the authority evaluates, in the order they are declared. */
  readonly states: readonly string[];
  /** The keys whose setter it uses: those a binding is issued for. */
  readonly writable: readonly string[];
  /** Its updaters: the keys each writes, and whether it runs a function or sets a value. */
  readonly updaters: Readonly<
    Record<string, { readonly keys: readonly string[]; readonly kind: 'apply' | 'set' }>
  >;
  readonly slots: readonly string[];
  /**
   * Its dynamic sites, by id: the local states the page sends for each (`inputs`) — those it is
   * rendered of, and those the conditions it stands under read (`guard`) — and whether it is a
   * list, rendered for each item of an array of them (`list`).
   */
  readonly sites: Readonly<
    Record<
      string,
      {
        readonly inputs: readonly string[];
        readonly guard: readonly string[];
        readonly list?: true;
      }
    >
  >;
  /** Its props that hold nodes (`children`), which a page renders a root without. */
  readonly nodes: readonly string[];
  /** The reactive components it renders, by id. */
  readonly renders: readonly string[];
}
