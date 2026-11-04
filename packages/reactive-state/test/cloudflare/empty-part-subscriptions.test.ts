import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { AuthorityEngine } from '../../src/authority/engine.ts';
import { durableObjectSql } from '../../src/cloudflare/sql.ts';
import {
  emptyPartApplication,
  emptyPartCases,
  emptyPartRoundtrip,
} from '../support/empty-part-subscriptions.ts';
import { authority } from './helpers.ts';

describe('explicit empty parts retained by subscriptions', () => {
  it.each(emptyPartCases)('preserves $name across event-driven renders', async (test) => {
    const result = await runInDurableObject(authority(), async (_instance, state) => {
      const engine = new AuthorityEngine({
        ...emptyPartApplication,
        sql: durableObjectSql(state.storage),
      });
      try {
        return await emptyPartRoundtrip(engine, test);
      } finally {
        await engine.close();
      }
    });

    expect(result.shown).toMatchObject({
      childSites: test.childSites,
      parentRefused: test.parentRefused,
    });
    expect(result.stableBeforeCommit).toBe(true);
    expect(result.dependsOnCommit).toBe(true);
    expect(result.after).toMatchObject({
      childSites: test.childSites,
      parentRefused: test.parentRefused,
    });
    expect(result.after.text).toContain('Changed subscription title');
  });
});
