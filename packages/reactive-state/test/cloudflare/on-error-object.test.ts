import { env } from 'cloudflare:workers';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AuthorityStub } from './helpers.ts';
import { failingProgram, REPORT_TABLE } from './on-error-fixture.ts';

describe('onError of an object made by authorityObject', () => {
  it('is given the environment of the object, with the bindings the object has', async () => {
    await env.REACTIVE_D1.exec(`DROP TABLE IF EXISTS ${REPORT_TABLE}`);
    await env.REACTIVE_D1.exec(`CREATE TABLE ${REPORT_TABLE} (kind TEXT, site TEXT)`);
    const stub = env.REPORTING.getByName(crypto.randomUUID()) as unknown as AuthorityStub;
    onTestFinished(async () => {
      await env.REACTIVE_D1.exec(`DROP TABLE IF EXISTS ${REPORT_TABLE}`);
    });
    const session = { expires: Date.now() + 60_000, id: 'reporting', user: 'alice' };
    const root = { build: failingProgram.buildId, component: failingProgram.component, props: {} };

    // The fault is the render's answer as well; the hook is told of it on a later turn.
    try {
      await stub.render(session, root);
    } catch {
      // The render's answer is the fault too.
    }

    await vi.waitFor(async () => {
      const { results } = await env.REACTIVE_D1.prepare(
        `SELECT kind, site FROM ${REPORT_TABLE}`,
      ).all();

      expect(results).toStrictEqual([{ kind: 'render', site: 'https://site.test' }]);
    });
  });
});
