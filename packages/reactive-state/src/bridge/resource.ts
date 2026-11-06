import { type ChangeEvent, recordTag, resourceOf } from '../program.ts';

/**
 * A resource change, as a cache that takes them reads one (`applyResourceChange`): numbered by
 * whatever reports it, keyed by the event so that a change delivered twice is applied once.
 */
export interface ResourceChangeInput {
  readonly scopeId: string;
  readonly resourceId: string;
  readonly eventId: string;
  readonly version: number;
  /** The tag the resource's entries carry. */
  readonly tag: string;
  /** The public routes the cache renders again without a visitor; none unless given. */
  readonly allowedRoutes?: string[] | undefined;
  readonly reconcile?: boolean | undefined;
}

/** What a cache answers a resource change: its revision once applied, or why the scope took none. */
export type ResourceChangeResult =
  | {
      readonly kind: 'applied' | 'already-applied';
      readonly revision: number;
      readonly affectedEntryIds: string[];
      readonly queuedJobs: number;
    }
  | { readonly kind: 'unavailable'; readonly reason: 'unknown' | 'retired' };

/**
 * The authority's change log translated for a cache that takes resource changes itself
 * (`applyResourceChange`, `@stayingupwind/cache`'s control entrypoint): each record a change
 * published — a record of a table with public fields, which a page rendered without a session may
 * show — invalidates its tag (`recordTag`), stale-while-revalidate, numbered by the authority's
 * revision — which the cache keeps per resource, so a change delivered twice is applied once — and
 * may name the public routes the cache should render again ahead of visitors. A record of a table
 * without public fields is in no page the cache keeps, and invalidates nothing.
 *
 * Nothing calls this on a local stack: `startStack` does not hand the host its cache's control
 * entrypoint, so the bridge there is the application's own route (`changes.ts`).
 */
export interface ResourceChangeTarget {
  readonly applyResourceChange: (input: ResourceChangeInput) => Promise<ResourceChangeResult>;
}

export interface DatabaseChange {
  readonly scopeId: string;
  readonly event: ChangeEvent;
  /**
   * The routes rendered again after a change to a record (`table:id`), as the application's pages
   * show its records; none unless given.
   */
  readonly routesFor?: (resource: string) => readonly string[];
}

export interface AppliedChange {
  readonly resource: string;
  readonly dbRevision: number;
  readonly cacheRevision: number;
}

export async function applyDatabaseChange(
  target: ResourceChangeTarget,
  change: DatabaseChange,
): Promise<readonly AppliedChange[]> {
  const applied: AppliedChange[] = [];
  for (const resource of change.event.published) {
    const record = resourceOf(resource);
    if (record === undefined) {
      continue;
    }
    const result = await target.applyResourceChange({
      allowedRoutes: [...(change.routesFor?.(resource) ?? [])],
      eventId: `${change.event.eventId}:${resource}`,
      resourceId: resource,
      scopeId: change.scopeId,
      tag: recordTag(record.table, record.id),
      version: change.event.revision,
    });
    // A retired or unknown scope is not a live one delivered to: the change is not acknowledged.
    if (result.kind === 'unavailable') {
      throw new Error(`The cache scope is unavailable: ${result.reason}`);
    }
    applied.push({ cacheRevision: result.revision, dbRevision: change.event.revision, resource });
  }
  return applied;
}
