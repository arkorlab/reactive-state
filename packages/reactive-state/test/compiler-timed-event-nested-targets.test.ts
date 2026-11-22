import type { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unsettledIn } from '../src/compiler/settled.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

const EVENT_STAMP_REFUSAL = "reads an event's `timeStamp`, of the time it was made";

const CASES = [
  {
    expected: EVENT_STAMP_REFUSAL,
    id: 'nested-object-targets-assign-an-event',
    source:
      "export function f() { let e: Event | undefined; ({ box: { e } } = { box: { e: new Event('x') } }); return e!.timeStamp; }",
  },
  {
    expected: EVENT_STAMP_REFUSAL,
    id: 'object-then-array-targets-assign-an-event',
    source:
      "export function f() { let e: Event | undefined; ({ list: [e] } = { list: [new Event('x')] }); return e!.timeStamp; }",
  },
  {
    expected: EVENT_STAMP_REFUSAL,
    id: 'array-then-object-targets-assign-an-event',
    source:
      "export function f() { let e: Event | undefined; [{ e }] = [{ e: new Event('x') }]; return e!.timeStamp; }",
  },
  {
    expected: EVENT_STAMP_REFUSAL,
    id: 'three-levels-of-object-targets',
    source:
      "export function f() { let e: Event | undefined; ({ a: { b: { e } } } = { a: { b: { e: new Event('x') } } }); return e!.timeStamp; }",
  },
  {
    expected: EVENT_STAMP_REFUSAL,
    id: 'nested-loop-header-target',
    source:
      "export function f() { let e: Event | undefined; for ({ box: { e } } of [{ box: { e: new Event('x') } }]) { return e!.timeStamp; } return 0; }",
  },
  {
    expected: EVENT_STAMP_REFUSAL,
    id: 'default-of-a-nested-object-target',
    source:
      "export function f() { let e: Event | undefined; ({ box: { e = new Event('x') } } = { box: {} } as { box: { e?: Event } }); return e!.timeStamp; }",
  },
  {
    expected: EVENT_STAMP_REFUSAL,
    id: 'default-of-an-object-target-nested-in-an-array',
    source:
      "export function f() { let e: Event | undefined; [{ e = new Event('x') }] = [{}] as { e?: Event }[]; return e!.timeStamp; }",
  },
  {
    expected: EVENT_STAMP_REFUSAL,
    id: 'default-of-an-array-target-nested-in-an-object',
    source:
      "export function f() { let e: Event | undefined; ({ list: [e = new Event('x')] } = { list: [] as Event[] }); return e!.timeStamp; }",
  },
  {
    expected: EVENT_STAMP_REFUSAL,
    id: 'default-of-a-flat-object-target-pin',
    source:
      "export function f() { let e: Event | undefined; ({ e = new Event('x') } = {} as { e?: Event }); return e!.timeStamp; }",
  },
  {
    expected: EVENT_STAMP_REFUSAL,
    id: 'flat-object-target-pin',
    source:
      "export function f() { let e: Event | undefined; ({ e } = { e: new Event('x') }); return e!.timeStamp; }",
  },
  {
    expected: EVENT_STAMP_REFUSAL,
    id: 'nested-declaration-pin',
    source:
      "export function f() { const { a: { b: { e } } } = { a: { b: { e: new Event('x') } } }; return e.timeStamp; }",
  },
  {
    expected: undefined,
    id: 'nested-targets-of-plain-objects-pin',
    source:
      'export function f() { let e = { timeStamp: 0 }; ({ a: { e } } = { a: { e: { timeStamp: 1 } } }); return e.timeStamp; }',
  },
  {
    expected: undefined,
    id: 'nested-target-of-a-sibling-event-pin',
    source:
      "export function f() { let e = { timeStamp: 0 }; let other: Event | undefined; ({ a: { e }, b: { other } } = { a: { e: { timeStamp: 1 } }, b: { other: new Event('x') } }); void other; return e.timeStamp; }",
  },
] as const;

describe('a destructuring write takes its value along the whole path from the outer pattern', () => {
  let api: API;

  beforeAll(() => {
    api = openTypeScript();
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Evaluates `unsettledIn` on a shared module reading a `timeStamp` a nested target assigned. */
  function refusalIn(source: string): string | undefined {
    using parsed = parseModule(api, 'timed-event-nested-targets.ts', source);

    return unsettledIn(parsed.sourceFile);
  }

  it.each(CASES)('$id', ({ expected, source }) => {
    expect(refusalIn(source)).toBe(expected);
  });
});
