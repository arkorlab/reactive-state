import { describe, expect, it, onTestFinished } from 'vitest';

import { nodeSql } from '../src/authority/node-sql.ts';
import { META } from '../src/authority/schema.ts';
import { SharedStore } from '../src/authority/shared-store.ts';
import { SiteShapes } from '../src/authority/site-shapes.ts';
import type { SqlDriver } from '../src/authority/sql.ts';
import type { SiteShape } from '../src/routing.ts';

/**
 * Where the build's site serves its routes, as a page's render or a gate's question says it
 * (`SiteShapes.learn`): kept in the store, which an authority started again reads it from (`load`),
 * where the store's write of it failed once too.
 */

const BUILD = 'b_site';

/** A site under a base path of its own, whose paths end with a slash. */
const SITE: SiteShape = { basePath: '/docs', trailingSlash: true };

/** The store's database, in memory and closed when the test finishes; and it, of a write that fails. */
function failingOnce(): { readonly sql: SqlDriver; readonly failing: SqlDriver } {
  const sql = nodeSql(':memory:');
  onTestFinished(() => {
    sql.close();
  });
  sql.run(META);
  let fails = true;
  const failing: SqlDriver = {
    all: (query, ...parameters) => sql.all(query, ...parameters),
    close: () => {
      sql.close();
    },
    get: (query, ...parameters) => sql.get(query, ...parameters),
    run: (query, ...parameters) => {
      if (fails) {
        fails = false;
        throw new Error('database or disk is full');
      }
      sql.run(query, ...parameters);
    },
    transaction: (body) => sql.transaction(body),
  };
  return { failing, sql };
}

describe('the build’s site, as its pages say it', () => {
  it('is written again where its write failed, and an authority started again reads it', () => {
    const { failing, sql } = failingOnce();
    const sites = new SiteShapes(new SharedStore(failing), BUILD);

    expect(() => {
      sites.learn(SITE);
    }).toThrow('database or disk is full');

    sites.learn(SITE);

    const started = new SiteShapes(new SharedStore(sql), BUILD);
    started.load();

    expect(started.orBuild(undefined)).toStrictEqual(SITE);
  });
});
