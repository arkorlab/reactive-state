/**
 * The extensions a convention file of Next.js's is written with in an app directory — a page, a
 * layout, the rest — as Next.js reads one by default (`pageExtensions`): the only ones the compile
 * reads one by (`route-scan.ts`). A config of others is refused as Next.js reads it
 * (`requirePageExtensions`, `next/config.ts`): a page of another would be a route the compile never
 * registers. A module of its own, which imports nothing: the config's module reads it as Next.js
 * loads an application's config, with nothing of the compiler's beside it.
 */
export const PAGE_EXTENSIONS: readonly string[] = ['tsx', 'ts', 'jsx', 'js'];
