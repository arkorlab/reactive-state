import { describe, expect, it } from 'vitest';

import { Engine } from '../src/authority/index.ts';
import {
  emptyPartApplication,
  emptyPartCases,
  emptyPartRoundtrip,
} from './support/empty-part-subscriptions.ts';

describe('explicit empty parts retained by subscriptions', () => {
  it.each(emptyPartCases)('preserves $name across event-driven renders', async (test) => {
    const engine = new Engine(emptyPartApplication);
    try {
      const result = await emptyPartRoundtrip(engine, test);

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
    } finally {
      await engine.close();
    }
  });
});
