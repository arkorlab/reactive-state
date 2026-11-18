import type { Node } from 'typescript/ast';
import { API } from 'typescript/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { dateText, localRead } from '../src/compiler/local-reads.ts';

const DATE_TEXT_REASON = 'writes a date as text of the time zone where it runs';

const CASES = [
  {
    body: 'class Day extends Date {} return new Day(0).toString();',
    expected: DATE_TEXT_REASON,
    id: 'subclass-construction-tostring',
  },
  {
    body: 'class Day extends Date {} const day = new Day(0); return String(day);',
    expected: DATE_TEXT_REASON,
    id: 'subclass-variable-string-call',
  },
  {
    body: `class Day extends Date {} const day = new Day(0); return \`\${day}\`;`,
    expected: DATE_TEXT_REASON,
    id: 'subclass-variable-in-template',
  },
  {
    body: "class Day extends Date {} return new Day(0) + '';",
    expected: DATE_TEXT_REASON,
    id: 'subclass-construction-added-to-text',
  },
  {
    body: 'class Day extends Date {} class Week extends Day {} return new Week(0).toString();',
    expected: DATE_TEXT_REASON,
    id: 'subclass-of-a-subclass',
  },
  {
    body: 'class Day extends Date {} const Alias = Day; return new Alias(0).toString();',
    expected: DATE_TEXT_REASON,
    id: 'constant-alias-of-a-subclass',
  },
  {
    body: 'const Base = Date; class Day extends Base {} return new Day(0).toString();',
    expected: DATE_TEXT_REASON,
    id: 'subclass-of-a-constant-alias-of-date',
  },
  {
    body: 'class Day extends globalThis.Date {} return new Day(0).toString();',
    expected: DATE_TEXT_REASON,
    id: 'subclass-of-global-date-path',
  },
  {
    body: 'const Day = class extends Date {}; return new Day(0).toString();',
    expected: DATE_TEXT_REASON,
    id: 'class-expression-subclass',
  },
  {
    body: 'class Day extends Date {} function show(day: Day) { return day.toString(); } return show;',
    expected: DATE_TEXT_REASON,
    id: 'parameter-typed-as-subclass',
  },
  {
    body: 'class Day extends Date {} function show(day: Day | null) { return String(day); } return show;',
    expected: DATE_TEXT_REASON,
    id: 'parameter-typed-as-subclass-or-null',
  },
  {
    body: 'class Day extends Date {} const day: Day = make(); return day.toString();',
    expected: DATE_TEXT_REASON,
    id: 'variable-typed-as-subclass',
  },
  {
    body: 'class Day extends Date {} return Day.prototype.toString.call(date);',
    expected: DATE_TEXT_REASON,
    id: 'subclass-prototype-tostring',
  },
  {
    body: 'class Day extends Date {} return new Day(0).getHours();',
    expected: 'reads `getHours`, of the time zone or the locale where it runs',
    id: 'subclass-local-method-pin',
  },
  {
    body: 'class Day extends Date {} return new Day(0).toISOString();',
    expected: undefined,
    id: 'subclass-iso-string-alike',
  },
  {
    body: 'class Day extends Date {} return new Day(0).getTime();',
    expected: undefined,
    id: 'subclass-time-alike',
  },
  {
    body: 'class Box {} return new Box().toString();',
    expected: undefined,
    id: 'unrelated-class-tostring',
  },
  {
    body: 'class Stack extends Array {} return new Stack().toString();',
    expected: undefined,
    id: 'subclass-of-another-built-in',
  },
  {
    body: 'class Box {} function show(box: Box) { return box.toString(); } return show;',
    expected: undefined,
    id: 'parameter-typed-as-unrelated-class',
  },
  {
    body: 'class Date {} class Day extends Date {} return new Day().toString();',
    expected: undefined,
    id: 'locally-declared-date-class-is-not-the-global',
  },
  {
    body: 'class First extends Second {} class Second extends First {} return new First().toString();',
    expected: undefined,
    id: 'cyclic-heritage-terminates',
  },
  {
    body: 'return new Date(0).toString();',
    expected: DATE_TEXT_REASON,
    id: 'global-date-construction-pin',
  },
] as const;

describe('local reads of source classes that extend Date', () => {
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
      'local-date-subclasses.ts',
      `declare function make(): never;\nexport function inspectDate(date: Date, flag: boolean): unknown { void flag; ${body} }\n`,
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
