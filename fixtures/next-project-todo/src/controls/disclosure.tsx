'use client';

import { type ReactNode, useId, useState } from 'react';

// Ordinary application UI. It knows nothing of DB refs, frames or subscriptions.
export default function Disclosure({ title, children }: {
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const contentId = useId();

  return (
    <section data-testid="disclosure">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen(value => !value)}
      >
        {title}
      </button>
      <div id={contentId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
