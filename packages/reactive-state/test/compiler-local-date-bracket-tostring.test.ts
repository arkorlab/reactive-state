import type { Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { dateText, localRead } from '../src/compiler/local-reads.ts';

const DATE_TEXT_REASON = 'writes a date as text of the time zone where it runs';

const CASES = [
  {
    body: "return new Date(0)['toString']();",
    expected: DATE_TEXT_REASON,
    id: 'bracket-string-tostring-new-date',
  },
  {
    body: 'return new Date(0)[`toString`]();',
    expected: DATE_TEXT_REASON,
    id: 'bracket-template-tostring-new-date',
  },
  {
    body: "return date['to' + 'String']();",
    expected: DATE_TEXT_REASON,
    id: 'bracket-concat-tostring-date-param',
  },
  {
    body: "const method = 'toString'; return date[method]();",
    expected: DATE_TEXT_REASON,
    id: 'bracket-const-alias-tostring',
  },
  {
    body: "return date[flag ? 'toISOString' : 'toString']();",
    expected: DATE_TEXT_REASON,
    id: 'bracket-conditional-tostring',
  },
  {
    body: "return Date.prototype['toString'].call(date);",
    expected: DATE_TEXT_REASON,
    id: 'bracket-date-prototype-tostring-call',
  },
  {
    body: 'const { toString } = Date.prototype; return toString.call(date);',
    expected: DATE_TEXT_REASON,
    id: 'destructured-tostring-date-prototype',
  },
  {
    body: "let format!: () => string; ({ ['toString']: format } = new Date(0)); return format();",
    expected: DATE_TEXT_REASON,
    id: 'assigned-destructured-bracket-tostring',
  },
  {
    body: "const method = 'getHours'; return date[method]();",
    expected: 'reads `getHours`, of the time zone or the locale where it runs',
    id: 'bracket-const-alias-local-method',
  },
  {
    body: "const method = 'getMinutes'; const { [method]: read } = Date.prototype; return read.call(date);",
    expected: 'reads `getMinutes`, of the time zone or the locale where it runs',
    id: 'destructured-const-computed-local-method',
  },
  {
    body: 'return new Date(0).toString();',
    expected: DATE_TEXT_REASON,
    id: 'dotted-tostring-new-date',
  },
  {
    body: "return new Date(0)['toISOString']();",
    expected: undefined,
    id: 'bracket-toisostring-new-date',
  },
  {
    body: "return ({ toString: () => 'fixed' })['toString']();",
    expected: undefined,
    id: 'bracket-tostring-non-date',
  },
  {
    body: 'const { toString } = Object.prototype; return toString.call({});',
    expected: undefined,
    id: 'destructured-tostring-object-prototype',
  },
  {
    body: "let method = 'getHours'; method = 'getUTCHours'; return (date as unknown as Record<string, () => number>)[method]();",
    expected: undefined,
    id: 'mutable-let-bracket-method',
  },
] as const;

describe('local date text and method reads via bracketed and constant keys', () => {
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
      'local-date-bracket-tostring.ts',
      `export function inspectDate(date: Date, flag: boolean): unknown { ${body} }\n`,
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
