'use client';

import { useRef, useState } from 'react';

// Ordinary application UI, based on the already integrated fixture's controlled controls.
// Nothing in this module knows about the database or the reactive runtime.
export function TextInput({ value, onChange, 'aria-label': label }: {
  value: string;
  onChange: (value: string) => void;
  'aria-label'?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const composed = useRef<string | null>(null);
  return (
    <input
      aria-label={label}
      value={draft ?? value}
      onChange={event => {
        const next = event.currentTarget.value;
        if ((event.nativeEvent as InputEvent).isComposing) {
          setDraft(next);
          return;
        }
        setDraft(null);
        const alreadyTold = composed.current === next;
        composed.current = null;
        if (!alreadyTold) onChange(next);
      }}
      onCompositionStart={event => {
        setDraft(event.currentTarget.value);
      }}
      onCompositionEnd={event => {
        const next = event.currentTarget.value;
        composed.current = next;
        setDraft(null);
        onChange(next);
      }}
    />
  );
}

export function Checkbox({ checked, onCheckedChange, 'aria-label': label }: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  'aria-label'?: string;
}) {
  return <input type="checkbox" aria-label={label} checked={checked}
    onChange={event => onCheckedChange(event.currentTarget.checked)} />;
}
