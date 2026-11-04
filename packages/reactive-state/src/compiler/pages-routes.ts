import { readdirSync } from 'node:fs';
import path from 'node:path';

import { PAGE_EXTENSIONS } from './page-extensions.ts';

/**
 * The routes of the Pages Router an application has beside its app directory — `pages`, beside
 * `app` (or `src/pages` beside `src/app`), as Next.js has the two — which Next.js serves alongside
 * the App Router's, an API route of `pages/api` among them: no route middleware of this package's is
 * ever around one. Each file of a page's extension is a route, Next.js's default extensions being
 * the only ones a build of the compile's is read with (`requirePageExtensions`), but the Pages
 * Router's own (`_app`, `_document`, `_error`), which serve none; an `index` is its directory's.
 */

/** A route of the Pages Router: its file, and its path as Next.js serves it, by its segments. */
export interface PagesRoute {
  readonly file: string;
  /** Its path's segments as Next.js names them: dynamic ones as written (`[id]`), none for `/`. */
  readonly segments: readonly string[];
}

/** The extensions a route of the Pages Router is written with, as files end in them. */
const EXTENSIONS: ReadonlySet<string> = new Set(
  PAGE_EXTENSIONS.map((extension) => `.${extension}`),
);

/** The Pages Router's own files, at the top of `pages`, which serve no route. */
const OWN_FILES: ReadonlySet<string> = new Set(['_app', '_document', '_error']);

/** The Pages Router's directory beside the app directory `appDir`. */
function pagesDirOf(appDir: string): string {
  return path.join(path.dirname(appDir), 'pages');
}

/** The routes of the Pages Router beside the app directory `appDir`: none where it has none. */
export function pagesRoutesOf(appDir: string): readonly PagesRoute[] {
  const directory = pagesDirOf(appDir);
  let entries;
  try {
    entries = readdirSync(directory, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry): PagesRoute[] => {
    const extension = path.extname(entry.name);
    if (entry.isDirectory() || !EXTENSIONS.has(extension)) {
      return [];
    }
    const file = path.join(entry.parentPath, entry.name);
    const named = path.relative(directory, file).slice(0, -extension.length).split(path.sep);
    if (named.length === 1 && OWN_FILES.has(named[0] ?? '')) {
      return [];
    }
    return [{ file, segments: named.at(-1) === 'index' ? named.slice(0, -1) : named }];
  });
}
