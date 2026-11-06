import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { AuthorityEngine } from '../../src/authority/engine.ts';
import { durableObjectSql } from '../../src/cloudflare/sql.ts';
import { resultApplication } from '../support/operation-result-slots.ts';
import {
  checkReflectionFailure,
  checkSnapshotReceipts,
  operationSnapshotChecks,
  reflectionCases,
  snapshotCases,
  throwingResult,
} from '../support/operation-result-snapshots.ts';
import { authority } from './helpers.ts';

// eslint-disable-next-line vitest/require-hook -- This call registers the shared snapshot cases.
operationSnapshotChecks();

describe('actual Durable Object operation result snapshots', () => {
  it.each(snapshotCases)('$name', async ({ make }) => {
    expect.hasAssertions();

    await runInDurableObject(authority(), async (_instance, state) => {
      const snapshot = make();
      const application = resultApplication(snapshot.value, snapshot.commit === true);
      const engine = new AuthorityEngine({
        ...application.options,
        sql: durableObjectSql(state.storage),
      });
      try {
        await checkSnapshotReceipts(engine, snapshot, application.runs);
      } finally {
        await engine.close();
      }
    });
  });

  describe.each([false, true])('first reflection trap after commit=%s', (commit) => {
    it.each(reflectionCases)('keeps the %s failure on a deduplicated resend', async (trap) => {
      expect.hasAssertions();

      await runInDurableObject(authority(), async (_instance, state) => {
        const application = resultApplication(throwingResult(trap), commit);
        const engine = new AuthorityEngine({
          ...application.options,
          sql: durableObjectSql(state.storage),
        });
        try {
          await checkReflectionFailure(engine, commit, application.runs);
        } finally {
          await engine.close();
        }
      });
    });
  });
});
