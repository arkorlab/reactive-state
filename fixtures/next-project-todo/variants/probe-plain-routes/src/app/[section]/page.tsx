import type { ReactNode } from 'react';

/**
 * A probe of this repository's, not part of the specification: a page of no reactive root whose
 * route is one dynamic segment, under the app's middleware alone — the page Next.js looks up for a
 * path of one segment no other route has, `/PROJECTS` among them, which the projects index's rewrite
 * matches regardless of case: that request is delivered, and its page asked for, as the index's.
 */
export default function Section(): ReactNode {
  return (
    <main>
      <p data-testid="section">section</p>
    </main>
  );
}
