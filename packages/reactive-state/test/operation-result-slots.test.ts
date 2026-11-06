import { describe, expect, it } from 'vitest';

import { isCarriedJson, isJson } from '../src/authority/canonical.ts';
import { Engine } from '../src/authority/index.ts';
import {
  nativeResultText,
  operationResultCases,
  resultApplication,
  resultReceipts,
} from './support/operation-result-slots.ts';

describe('operation result own slots', () => {
  it.each(operationResultCases)('$name', async (test) => {
    const fixture = test.make();
    const before = Object.getOwnPropertyDescriptors(fixture.value);

    expect(nativeResultText(fixture.value)).toStrictEqual(fixture.native);

    fixture.calls.length = 0;

    expect(isCarriedJson(fixture.value)).toBe(fixture.valid !== false);
    expect(isJson(fixture.value)).toBe(fixture.strict ?? fixture.valid !== false);

    const application = resultApplication(fixture.value, fixture.revision !== undefined);
    const engine = new Engine(application.options);
    let kept;
    try {
      kept = { ...(await resultReceipts(engine)), runs: application.runs() };
    } finally {
      await engine.close();
    }

    expect(kept.first).toMatchObject({
      committedRevision: fixture.revision ?? null,
      deduplicated: false,
      result: fixture.expected,
    });
    expect(kept.again).toStrictEqual({ ...kept.first, deduplicated: true });
    expect([
      nativeResultText(kept.first.result),
      nativeResultText(kept.again.result),
    ]).toStrictEqual([nativeResultText(fixture.expected), nativeResultText(fixture.expected)]);
    expect({ stats: kept.stats, runs: kept.runs, calls: fixture.calls }).toMatchObject({
      stats: { deduplicated: 1, operationRuns: 1 },
      runs: 1,
      calls: [],
    });
    expect(Object.getOwnPropertyDescriptors(fixture.value)).toStrictEqual(before);
  });
});
