import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const EVENT_STAMP_REFUSAL = "reads an event's `timeStamp`, of the time it was made";

const CASES = [
  {
    expected: EVENT_STAMP_REFUSAL,
    id: 'loop-assigns-a-name-from-new-events',
    source:
      "export function f() { let e: Event | undefined; for (e of [new Event('x')]) { return e.timeStamp; } return 0; }",
  },
  {
    expected: EVENT_STAMP_REFUSAL,
    id: 'loop-destructures-the-stamp-of-new-events',
    source:
      "export function f() { let timeStamp = 0; for ({ timeStamp } of [new Event('x')]) { return timeStamp; } return 0; }",
  },
  {
    expected: EVENT_STAMP_REFUSAL,
    id: 'loop-destructures-an-event-member',
    source:
      "export function f() { let event: Event | undefined; for ({ event } of [{ event: new Event('x') }]) { return event!.timeStamp; } return 0; }",
  },
  {
    expected: EVENT_STAMP_REFUSAL,
    id: 'loop-destructures-an-array-of-events',
    source:
      "export function f() { let e: Event | undefined; for ([e] of [[new Event('x')]]) { return e!.timeStamp; } return 0; }",
  },
  {
    expected: EVENT_STAMP_REFUSAL,
    id: 'loop-destructures-the-stamp-from-an-event-held-by-a-constant',
    source:
      "const events = [new Event('x')]; export function f() { let timeStamp = 0; for ({ timeStamp } of events) { return timeStamp; } return 0; }",
  },
  {
    expected: undefined,
    id: 'loop-assigns-a-name-from-plain-objects-pin',
    source:
      'export function f(events: { timeStamp: number }[]) { let e = events[0]; for (e of events) { return e!.timeStamp; } return 0; }',
  },
  {
    expected: undefined,
    id: 'loop-destructures-the-stamp-of-plain-objects-pin',
    source:
      'export function f() { let timeStamp = 0; for ({ timeStamp } of [{ timeStamp: 1 }]) { return timeStamp; } return 0; }',
  },
  {
    expected: EVENT_STAMP_REFUSAL,
    id: 'loop-declaring-a-name-from-new-events-pin',
    source:
      "export function f() { for (const e of [new Event('x')]) { return e.timeStamp; } return 0; }",
  },
  {
    expected: EVENT_STAMP_REFUSAL,
    id: 'assignment-destructuring-the-stamp-of-a-new-event-pin',
    source:
      "export function f() { let timeStamp = 0; ({ timeStamp } = new Event('x')); return timeStamp; }",
  },
] as const;

describe('a for…of header that assigns takes its value from the iterable', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` on a shared module reading a `timeStamp` a loop header assigned. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'timed-event-loop-assignments.ts', source);

    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
