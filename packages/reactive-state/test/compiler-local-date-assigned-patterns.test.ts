import type { Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { dateText, localRead } from '../src/compiler/local-reads.ts';

const DATE_TEXT_REASON = 'writes a date as text of the time zone where it runs';

const CASES = [
  {
    body: "let format!: () => string; const method = 'toString'; ({ [method]: format } = date); return format.call(date);",
    expected: DATE_TEXT_REASON,
    id: 'assigned-pattern-const-key-tostring-date-param',
  },
  {
    body: "let format!: () => string; ({ [flag ? 'toISOString' : 'toString']: format } = date); return format.call(date);",
    expected: DATE_TEXT_REASON,
    id: 'assigned-pattern-conditional-key-tostring',
  },
  {
    body: "let format!: () => string; ({ ['to' + 'String']: format } = new Date(0)); return format();",
    expected: DATE_TEXT_REASON,
    id: 'assigned-pattern-concat-key-tostring-new-date',
  },
  {
    body: `let format!: () => string; const suffix = 'String'; ({ [\`to\${suffix}\`]: format } = date); return format.call(date);`,
    expected: DATE_TEXT_REASON,
    id: 'assigned-pattern-template-const-key-tostring',
  },
  {
    body: "let format!: () => string; const method = 'toString'; ({ [method]: format = () => 'fallback' } = date); return format.call(date);",
    expected: DATE_TEXT_REASON,
    id: 'assigned-pattern-const-key-defaulted-target-tostring',
  },
  {
    body: "let read!: () => number; const method = 'getHours'; ({ [method]: read } = Date.prototype); return read.call(date);",
    expected: 'reads `getHours`, of the time zone or the locale where it runs',
    id: 'assigned-pattern-const-key-local-method-date-prototype',
  },
  {
    body: "let read!: () => number; ({ [flag ? 'getUTCHours' : 'getMinutes']: read } = Date.prototype); return read.call(date);",
    expected: 'reads `getMinutes`, of the time zone or the locale where it runs',
    id: 'assigned-pattern-conditional-key-local-method',
  },
  {
    body: "const { ['to' + 'String']: format } = date; return format.call(date);",
    expected: DATE_TEXT_REASON,
    id: 'binding-pattern-concat-key-tostring',
  },
  {
    body: "let format!: () => string; const method = 'toISOString'; ({ [method]: format } = date); return format.call(date);",
    expected: undefined,
    id: 'assigned-pattern-const-key-toisostring-allowed',
  },
  {
    body: "const method = 'getHours'; const holder = { [method]: () => 0 }; return holder;",
    expected: undefined,
    id: 'value-object-literal-computed-const-key-not-taken-apart',
  },
  {
    body: "let format!: () => string; const method = 'toString'; ({ [method]: format } = { toString: () => 'fixed' }); return format();",
    expected: undefined,
    id: 'assigned-pattern-const-key-tostring-non-date-receiver',
  },
  {
    body: "let read!: () => number; let method = 'getHours'; method = 'getUTCHours'; ({ [method]: read } = Date.prototype as unknown as Record<string, () => number>); return read.call(date);",
    expected: undefined,
    id: 'assigned-pattern-mutable-let-key-unproven',
  },
] as const;

describe('local date text and method reads via computed assignment patterns', () => {
  let api: API;

  beforeAll(() => {
    api = new API({ cwd: process.cwd() });
  });

  afterAll(() => {
    api[Symbol.dispose]();
  });

  /** Walks `body` in top-down source order and answers the first `localRead` or `dateText` reason. */
  function firstLocalReason(body: string): string | undefined {
    using parsed = api.createSourceFile(
      'local-date-assigned-patterns.ts',
      `export function inspectDate(date: Date, flag: boolean): unknown { ${body} }
`,
    );
    let found: string | undefined;
    const visit = (node: Node): void => {
      if (found !== undefined) {
        return;
      }
      found = localRead(node) ?? dateText(node);
      if (found === undefined) {
        node.forEachChild(visit);
      }
    };
    parsed.sourceFile.forEachChild(visit);
    return found;
  }

  it.each(CASES)('$id', ({ body, expected }) => {
    expect(firstLocalReason(body)).toBe(expected);
  });
});
