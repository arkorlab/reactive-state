import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const EVENT_STAMP_REFUSAL = "reads an event's `timeStamp`, of the time it was made";

const CASES = [
  {
    expected: undefined,
    id: 'loop-assigns-a-member-then-reads-its-stamp',
    source:
      'export function stamp(target: { event: { timeStamp: number } }, events: { timeStamp: number }[]) { for (target.event of events) { return target.event.timeStamp; } return 0; }',
  },
  {
    expected: undefined,
    id: 'loop-assigns-a-member-from-typed-events',
    source:
      'export function stamp(target: { event: Event }, events: Event[]) { for (target.event of events) { return target.event.timeStamp; } return 0; }',
  },
  {
    expected: undefined,
    id: 'loop-assigns-an-element-then-reads-its-stamp',
    source:
      'export function stamp(slots: { timeStamp: number }[], events: { timeStamp: number }[]) { for (slots[0] of events) { return slots[0]!.timeStamp; } return 0; }',
  },
  {
    expected: undefined,
    id: 'loop-declaring-a-plain-object-pin',
    source:
      'export function stamp(events: { timeStamp: number }[]) { for (const event of events) { return event.timeStamp; } return 0; }',
  },
  {
    expected: EVENT_STAMP_REFUSAL,
    id: 'loop-declaring-a-new-event-pin',
    source:
      "export function stamp() { for (const e of [new Event('x')]) { return e.timeStamp; } return 0; }",
  },
  {
    expected: EVENT_STAMP_REFUSAL,
    id: 'loop-destructuring-a-new-event-pin',
    source:
      "export function stamp() { for (const { timeStamp } of [new Event('x')]) { return timeStamp; } return 0; }",
  },
  {
    expected: EVENT_STAMP_REFUSAL,
    id: 'statement-destructuring-a-new-event-pin',
    source: "export function stamp() { const { timeStamp } = new Event('x'); return timeStamp; }",
  },
] as const;

describe('a loop header that assigns a member is no declaration list', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` on a shared module reading `timeStamp` after a `for…of` header. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'timed-event-loop-targets.ts', source);

    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
