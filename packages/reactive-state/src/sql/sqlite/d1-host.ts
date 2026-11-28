import type { DatabaseHost } from '../../authority/database-host.ts';
import type { D1Binding } from './client.ts';
import type { DrizzleD1Follow } from './follow.ts';

/**
 * What a host of a D1 binding brings of the change log to the authority it is given, of a file in
 * D1's shape (`host.ts`) and of a Worker's or a deployment's D1 (`../../cloudflare/db.ts`, `../db.ts`)
 * alike: the log and each table's triggers, made in one batch, as D1 runs no transaction of
 * statements one at a time; the store that reads it; and its pruning of what is `keptMs` old.
 */
export function d1Hosted<S>(
  binding: D1Binding,
  follow: DrizzleD1Follow<S>,
  keptMs: number,
): Pick<DatabaseHost, 'open' | 'prune' | 'stores'> {
  return {
    open: async () => {
      await binding.batch(follow.captureSql().map((statement) => binding.prepare(statement)));
    },
    prune: () => follow.prune(binding, Date.now() - keptMs),
    stores: () => ({ [follow.storeName]: follow.store(binding) }),
  };
}
