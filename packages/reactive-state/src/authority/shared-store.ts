import type { RouteParams, SiteShape } from '../routing.ts';
import type { KeptDependencies } from './dependencies.ts';
import { integer, type Row, text } from './rows.ts';
import type { SqlDriver } from './sql.ts';
import type { Profile } from './view-tokens.ts';

/**
 * The shared views the authority keeps, and their artifacts, in its SQLite (`views`, `artifacts`):
 * one statement a method, as `Database` keeps everything else. A view is written whole as its state
 * moves; a commit that makes views dirty marks them in its own transaction (`markDirty`), so that no
 * answer of the commit's outruns the mark. An artifact is what the page answered for one profile of
 * one generation, of the deployment of the site that answered it, kept until a newer generation is
 * published or another deployment's is made in its place. Where the build's site serves its routes
 * is kept beside them (`site`).
 */

/** Where a shared view stands. */
export type ViewStatus = 'denied' | 'dirty' | 'private' | 'ready' | 'responded';

export interface StoredView {
  readonly key: string;
  readonly route: string;
  readonly params: RouteParams;
  readonly build: string;
  readonly status: ViewStatus;
  /**
   * The generation published, or a later one a page's own render was handed before it was, whose
   * `digest` is then unknown; 0 before the first.
   */
  readonly generation: number;
  /** The access epoch: a new one of the database's each time the view is revoked (`nextEpoch`). */
  readonly epoch: number;
  /** A digest of what the view showed when it was last evaluated; empty where it is unknown. */
  readonly digest: string;
  readonly dependencies: KeptDependencies;
  /** The revision it was last evaluated at. */
  readonly revision: number;
  /** When a request last asked for it, by the authority's clock. */
  readonly observed: number;
}

export interface StoredArtifact {
  readonly view: string;
  readonly generation: number;
  readonly profile: Profile;
  /** The deployment of the site whose page answered it: `x-nextjs-deployment-id`; none for none. */
  readonly deployment: string;
  readonly etag: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
  readonly created: number;
}

const STATUSES: readonly ViewStatus[] = ['denied', 'dirty', 'private', 'ready', 'responded'];

function statusOf(row: Row): ViewStatus {
  const status = text(row, 'status');
  const found = STATUSES.find((each) => each === status);
  if (found === undefined) {
    throw new TypeError(
      `A view is kept with the status ${status}, which this authority does not know`,
    );
  }
  return found;
}

function viewOf(row: Row): StoredView {
  return {
    build: text(row, 'build'),
    dependencies: JSON.parse(text(row, 'dependencies')) as KeptDependencies,
    digest: text(row, 'digest'),
    epoch: integer(row, 'epoch'),
    generation: integer(row, 'generation'),
    key: text(row, 'key'),
    observed: integer(row, 'observed'),
    params: JSON.parse(text(row, 'params')) as RouteParams,
    revision: integer(row, 'revision'),
    route: text(row, 'route'),
    status: statusOf(row),
  };
}

export class SharedStore {
  readonly #sql: SqlDriver;

  constructor(sql: SqlDriver) {
    this.#sql = sql;
  }

  /**
   * An access epoch no view of this database was given before — one more than the last, kept in
   * `meta` — for a view taken in and for each revocation of one: a view let go of and taken in
   * again starts past every epoch its earlier self reached, so no `ETag`, token or notice of that one
   * names the new one.
   */
  nextEpoch(): number {
    this.#sql.run("INSERT OR IGNORE INTO meta VALUES ('epoch', '0')");
    this.#sql.run("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'epoch'");
    return Number(this.#sql.get("SELECT value FROM meta WHERE key = 'epoch'")?.['value']);
  }

  /**
   * Where the site of the build `build` serves its routes, as its pages said (`putSite`, kept in
   * `meta`); none before one did, nor of another build.
   */
  site(build: string): SiteShape | undefined {
    const row = this.#sql.get("SELECT value FROM meta WHERE key = 'site_shape'");
    if (row === undefined) {
      return undefined;
    }
    const kept = JSON.parse(text(row, 'value')) as SiteShape & { readonly build: string };
    if (kept.build !== build) {
      return undefined;
    }
    const { basePath, skipTrailingSlashRedirect, trailingSlash } = kept;
    return {
      basePath,
      trailingSlash,
      ...(skipTrailingSlashRedirect === true && { skipTrailingSlashRedirect }),
    };
  }

  /** Keeps where the site of the build `build` serves its routes, in place of any other build's. */
  putSite(build: string, site: SiteShape): void {
    const { basePath, skipTrailingSlashRedirect, trailingSlash } = site;
    this.#sql.run(
      "INSERT OR REPLACE INTO meta VALUES ('site_shape', ?)",
      JSON.stringify({ basePath, build, skipTrailingSlashRedirect, trailingSlash }),
    );
  }

  /** Every view kept, of the build `build`; those of another build are let go of. */
  views(build: string): readonly StoredView[] {
    this.#sql.transaction(() => {
      this.#sql.run(
        'DELETE FROM artifacts WHERE view IN (SELECT key FROM views WHERE build <> ?)',
        build,
      );
      this.#sql.run('DELETE FROM views WHERE build <> ?', build);
    });
    return this.#sql.all('SELECT * FROM views').map((row) => viewOf(row));
  }

  /**
   * Keeps a view; and where what it published was withdrawn (`withdrawn`), lets go of its artifacts
   * in the same transaction — a page refused, or made the request's, kept no longer than it is shown.
   */
  put(view: StoredView, withdrawn = false): void {
    this.#sql.transaction(() => {
      this.#sql.run(
        'INSERT OR REPLACE INTO views VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        view.key,
        view.route,
        JSON.stringify(view.params),
        view.build,
        view.status,
        view.generation,
        view.epoch,
        view.digest,
        JSON.stringify(view.dependencies),
        view.revision,
        view.observed,
      );
      if (withdrawn) {
        this.#sql.run('DELETE FROM artifacts WHERE view = ?', view.key);
      }
    });
  }

  /** Marks the views `keys` dirty: in the transaction of the commit that changed what they read. */
  markDirty(keys: readonly string[]): void {
    for (const key of keys) {
      this.#sql.run("UPDATE views SET status = 'dirty' WHERE key = ?", key);
    }
  }

  /** Keeps when a request last asked for the view of `key`, and nothing else of it. */
  observe(key: string, observed: number): void {
    this.#sql.run('UPDATE views SET observed = ? WHERE key = ?', observed, key);
  }

  /** Lets go of a view and its artifacts. */
  drop(key: string): void {
    this.#sql.transaction(() => {
      this.#sql.run('DELETE FROM artifacts WHERE view = ?', key);
      this.#sql.run('DELETE FROM views WHERE key = ?', key);
    });
  }

  artifact(view: string, generation: number, profile: Profile): StoredArtifact | undefined {
    const row = this.#sql.get(
      'SELECT * FROM artifacts WHERE view = ? AND generation = ? AND profile = ?',
      view,
      generation,
      profile,
    );
    return row === undefined
      ? undefined
      : {
          body: text(row, 'body'),
          created: integer(row, 'created'),
          deployment: text(row, 'deployment'),
          etag: text(row, 'etag'),
          generation,
          headers: JSON.parse(text(row, 'headers')) as readonly (readonly [string, string])[],
          profile,
          view,
        };
  }

  /**
   * Keeps an artifact — in place of its profile's of its generation, whichever deployment made that
   * — and lets go of the view's artifacts of generations before `keepFrom`.
   */
  putArtifact(artifact: StoredArtifact, keepFrom: number): void {
    this.#sql.transaction(() => {
      this.#sql.run(
        'INSERT OR REPLACE INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        artifact.view,
        artifact.generation,
        artifact.profile,
        artifact.deployment,
        artifact.etag,
        JSON.stringify(artifact.headers),
        artifact.body,
        artifact.created,
      );
      this.#sql.run(
        'DELETE FROM artifacts WHERE view = ? AND generation < ?',
        artifact.view,
        keepFrom,
      );
    });
  }
}
