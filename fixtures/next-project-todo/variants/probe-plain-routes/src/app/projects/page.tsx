import type { ReactNode } from 'react';

/**
 * A probe of the compiler's, not part of the fixture's own pages (its other variants give no such
 * input): the projects' index, a page of no reactive root under X's projects middleware, whose
 * sign-in check it is delivered through all the same, as every route under a route middleware is.
 * The probe is X's route middleware, copied as X has it, this page, and pages of dynamic segments
 * beside it (`[section]`).
 */
export default function Projects(): ReactNode {
  return (
    <main>
      <h1 data-testid="projects">プロジェクト</h1>
      <p>
        <a href="/projects/p1?filter=all&todo=t1">プロジェクト p1 を開く</a>
      </p>
    </main>
  );
}
