import { describe, expect, it, onTestFinished } from 'vitest';

import { BUILD, open, quiet, viewTokenOf } from './support/shared-fixture.ts';

/** Only recently observed or actively followed views stay current after commits. */
const DAY_MS = 86_400_000;
type Following = 'none' | 'stopped' | 'active';

/** A matching commit after the requested idle interval, with a fresh authenticated session. */
async function changedView(elapsed: number, following: Following) {
  let now = Date.UTC(2026, 9, 17);
  const { ask, asked, engine } = await open({ clock: () => now });
  await ask('/boards/p1');
  if (following !== 'none') {
    const stream = await engine.followShared(await viewTokenOf(engine, 'p1'));
    onTestFinished(stream.stop);
    if (following === 'stopped') stream.stop();
  }
  await quiet(engine);
  const before = await engine.stats();
  const requests = asked.length;
  now += elapsed;
  const { sessionId } = await engine.login('alice');
  await engine.operate(sessionId, {
    args: [{ json: 't1' }, { json: 'changed after retention' }],
    build: BUILD,
    module: 'actions/admin',
    name: 'setTodoTitle',
    operationId: 'retention-write',
  });
  await quiet(engine);
  return { asked, before, engine, requests };
}

describe('shared views after their observation retention', () => {
  it.each(['none', 'stopped'] as const)(
    'lets go of an expired view whose following is %s before regenerating it',
    async (following) => {
      const { asked, before, engine, requests } = await changedView(DAY_MS + 1, following);

      await expect(engine.stats()).resolves.toMatchObject({
        generations: before.generations,
        sharedEvaluations: before.sharedEvaluations,
        sharedViews: 0,
      });
      expect(asked).toHaveLength(requests);
    },
  );

  it.each([
    { elapsed: DAY_MS, following: 'none' },
    { elapsed: 2 * DAY_MS, following: 'active' },
  ] as const)('keeps a current view with $following following after $elapsed', async (scenario) => {
    const { asked, before, engine, requests } = await changedView(
      scenario.elapsed,
      scenario.following,
    );

    await expect.poll(async () => (await engine.stats()).generations).toBe(before.generations + 2);
    expect(asked).toHaveLength(requests + 2);
  });
});
