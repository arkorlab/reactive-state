import { describe, expect, it } from 'vitest';

import { Engine } from '../src/authority/index.ts';
import { resultApplication } from './support/operation-result-slots.ts';
import {
  checkReflectionFailure,
  checkSnapshotReceipts,
  operationSnapshotChecks,
  reflectionCases,
  snapshotCases,
  throwingResult,
} from './support/operation-result-snapshots.ts';

// eslint-disable-next-line vitest/require-hook -- This call registers the shared snapshot cases.
operationSnapshotChecks();

describe('actual Node operation result snapshots', () => {
  it.each(snapshotCases)('$name', async ({ make }) => {
    expect.hasAssertions();

    const snapshot = make();
    const application = resultApplication(snapshot.value, snapshot.commit === true);
    const engine = new Engine(application.options);
    try {
      await checkSnapshotReceipts(engine, snapshot, application.runs);
    } finally {
      await engine.close();
    }
  });

  describe.each([false, true])('first reflection trap after commit=%s', (commit) => {
    it.each(reflectionCases)('keeps the %s failure on a deduplicated resend', async (trap) => {
      expect.hasAssertions();

      const application = resultApplication(throwingResult(trap), commit);
      const engine = new Engine(application.options);
      try {
        await checkReflectionFailure(engine, commit, application.runs);
      } finally {
        await engine.close();
      }
    });
  });
});
