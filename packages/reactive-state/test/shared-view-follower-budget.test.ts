import { describe, expect, it, onTestFinished } from 'vitest';

import type { Engine } from '../src/authority/index.ts';
import { MAX_VIEWS, type SharedFollowing } from '../src/authority/shared-views.ts';
import { BUILD, open } from './support/shared-fixture.ts';

/** Anonymous shared streams retain a bounded part of the authority's view capacity. */

const FOLLOWER_BUDGET = MAX_VIEWS - 1;
const CAPACITY = { code: 'TOO_MANY_SHARED_STREAMS', status: 503 };

/** An anonymous render's actual signed token, without a session or a forged claim. */
async function tokenOf(engine: Engine, id: string): Promise<string> {
  const answer = await engine.renderShared(null, {
    build: BUILD,
    props: { pinId: id },
    route: '/pinned/[pinId]',
  });
  if (answer.kind !== 'shared') throw new Error('The public route is shared.');
  return answer.view.token;
}

/** Every accepted following is released even when a regression assertion stops its test. */
function stoppedAfterTest(): SharedFollowing[] {
  const followings: SharedFollowing[] = [];
  onTestFinished(() => {
    for (const following of followings) following.stop();
  });
  return followings;
}

describe('the authority shared follower budget', () => {
  it('retains an evictable view slot after anonymous followers exhaust their budget', async () => {
    const { engine } = await open();
    engine.site(undefined);
    const followings = stoppedAfterTest();
    for (let index = 0; index < FOLLOWER_BUDGET; index += 1) {
      const token = await tokenOf(engine, `held-${String(index)}`);
      followings.push(await engine.followShared(token));
    }
    const extra = await tokenOf(engine, 'unfollowed');

    await expect(engine.followShared(extra)).rejects.toMatchObject(CAPACITY);
    await expect(tokenOf(engine, 'another-document')).resolves.toBeTypeOf('string');
    await expect(engine.stats()).resolves.toMatchObject({
      sharedStreams: FOLLOWER_BUDGET,
      sharedViews: MAX_VIEWS,
    });
  });

  it('counts same-view and unlistened followers, preserves checks and readmits after one stop', async () => {
    const { engine } = await open();
    engine.site(undefined);
    const token = await tokenOf(engine, 'same');
    const followings = stoppedAfterTest();
    for (let index = 0; index < FOLLOWER_BUDGET; index += 1)
      followings.push(await engine.followShared(token));
    const before = await engine.stats();

    await expect(engine.followShared(token)).rejects.toMatchObject(CAPACITY);
    await expect(engine.followShared('forged')).rejects.toMatchObject({ status: 403 });
    await expect(engine.checkShared(token)).resolves.toBeUndefined();
    await expect(engine.stats()).resolves.toMatchObject({
      sharedStreams: before.sharedStreams,
      sharedViews: before.sharedViews,
    });

    followings[0]?.stop();
    followings[0]?.stop();

    await expect(engine.stats()).resolves.toMatchObject({ sharedStreams: FOLLOWER_BUDGET - 1 });

    followings.push(await engine.followShared(token));

    await expect(engine.stats()).resolves.toMatchObject({
      sharedStreams: FOLLOWER_BUDGET,
      sharedViews: 1,
    });
  });
});
