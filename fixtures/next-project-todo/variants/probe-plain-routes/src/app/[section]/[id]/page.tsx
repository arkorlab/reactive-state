import type { ReactNode } from 'react';

/**
 * A probe of this repository's, not part of the specification: a page of no reactive root whose
 * route is two dynamic segments, under the app's middleware alone — the page Next.js looks up for
 * `/BOARDS/p1` and `/PROJECTS/p1`, which the board's and the project's rewrites match regardless of
 * case, each delivered, and its page asked for, as that route's; and this route's own page for
 * `/%62oards/p1`, which no rewrite of the board's matches, asked for as the visitor spelled it.
 */
export default function SectionItem(): ReactNode {
  return (
    <main>
      <p data-testid="section-item">section item</p>
    </main>
  );
}
