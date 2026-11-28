import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { provenEmpty } from '../../src/sql/sqlite/unwritten.ts';

/**
 * The read that proves an empty `RETURNING`, on the D1 binding as Miniflare runs it: it answers of
 * both schemas at once, proves a plain table, and proves nothing of one with a trigger that runs
 * before.
 */

describe('the schema read that proves an empty RETURNING', () => {
  it('answers on the binding, and proves a plain table', async () => {
    await env.REACTIVE_D1.exec('DROP TABLE IF EXISTS proven_tasks');
    await env.REACTIVE_D1.exec('CREATE TABLE proven_tasks (id TEXT PRIMARY KEY, title TEXT)');

    await expect(provenEmpty(env.REACTIVE_D1, 'proven_tasks')).resolves.toBe(true);
  });

  it('proves nothing of a table with a trigger that runs before', async () => {
    await env.REACTIVE_D1.exec('DROP TABLE IF EXISTS proven_before');
    await env.REACTIVE_D1.exec('CREATE TABLE proven_before (id TEXT)');
    await env.REACTIVE_D1.exec(
      'CREATE TRIGGER proven_before_t BEFORE INSERT ON proven_before BEGIN SELECT 1; END',
    );

    await expect(provenEmpty(env.REACTIVE_D1, 'proven_before')).resolves.toBe(false);
  });
});
