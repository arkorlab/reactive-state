import type { Metrics } from './model.ts';

/** The authority's counters before anything has happened. */
export function emptyMetrics(): Metrics {
  return {
    appReads: 0,
    artifactBytes: 0,
    artifactReads: 0,
    artifactRenders: 0,
    cacheHits: 0,
    commits: 0,
    deduplicated: 0,
    evaluations: 0,
    gateLookups: 0,
    gateWaits: 0,
    generationFailures: 0,
    generations: 0,
    guardEvaluations: 0,
    invalidations: 0,
    memoEvictions: 0,
    memoHits: 0,
    middlewareReads: 0,
    nextRenders: 0,
    operationRuns: 0,
    queryEvaluations: 0,
    renderQueries: 0,
    renders: 0,
    sharedEvaluations: 0,
    siteRenders: 0,
    updaterRuns: 0,
  };
}
