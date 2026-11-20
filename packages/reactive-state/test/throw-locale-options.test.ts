import {
  type Expression,
  isIdentifier,
  isNewExpression,
  isVariableStatement,
  type NewExpression,
  type Node,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import { LOCALE_TAKERS } from '../src/compiler/throw-locales.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

interface Row {
  readonly id: string;
  readonly source: string;
  /** Whether the compile follows the constants of the module, as a reader that does. */
  readonly resolved?: boolean;
}

/** What `Intl.Locale` throws in Node 26.13.1 and in workerd 1.20261116.1, alike. */
const THROWING: readonly Row[] = [
  { id: 'calendar of nine letters', source: "new Intl.Locale('en', { calendar: 'gregorian' });" },
  { id: 'calendar with a space', source: "new Intl.Locale('en', { calendar: 'not valid!' });" },
  { id: 'hour cycle out of range', source: "new Intl.Locale('en', { hourCycle: 'invalid' });" },
  { id: 'region of three letters', source: "new Intl.Locale('en', { region: 'USA' });" },
  { id: 'case first out of range', source: "new Intl.Locale('en', { caseFirst: 'bad' });" },
  { id: 'script too long', source: "new Intl.Locale('en', { script: 'toolong' });" },
  { id: 'a number for a calendar', source: "new Intl.Locale('en', { calendar: 5 });" },
  { id: 'null options', source: "new Intl.Locale('en', null);" },
  {
    id: 'array of one tag',
    source: "new Intl.Locale(['en'], { calendar: 'gregorian' });",
  },
  {
    id: 'options kept in a constant',
    resolved: true,
    source: "const options = { calendar: 'gregorian' };\nnew Intl.Locale('en', options);",
  },
  {
    id: 'tag and options kept in constants',
    resolved: true,
    source:
      "const tag = 'en-US';\nconst options = { region: 'USA' };\nnew Intl.Locale(tag, options);",
  },
];

/** What `Intl.Locale` takes in both, or what the code does not write whole. */
const UNPROVEN: readonly Row[] = [
  { id: 'a valid hour cycle', source: "new Intl.Locale('en', { hourCycle: 'h23' });" },
  {
    id: 'several valid options',
    source:
      "new Intl.Locale('en-US', { calendar: 'gregory', numberingSystem: 'latn', region: 'US' });",
  },
  {
    id: 'a boolean the module does not read as a constant',
    source: "new Intl.Locale('en', { hourCycle: true });",
  },
  { id: 'empty options', source: "new Intl.Locale('en', {});" },
  { id: 'no options', source: "new Intl.Locale('en');" },
  { id: 'undefined options', source: "new Intl.Locale('en', undefined);" },
  { id: 'a number for options', source: "new Intl.Locale('en', 5);" },
  {
    id: 'a tag with an extension',
    source: "new Intl.Locale('en-u-ca-gregory', { hourCycle: 'h23' });",
  },
  {
    id: 'valid options kept in a constant',
    resolved: true,
    source: "const options = { hourCycle: 'h23' };\nnew Intl.Locale('en', options);",
  },
  {
    id: 'invalid options kept in a name the module does not resolve',
    source: "const options = { calendar: 'gregorian' };\nnew Intl.Locale('en', options);",
  },
  {
    id: 'an option the code does not write',
    source:
      "declare const first: string;\nnew Intl.Locale('en', { calendar: 'gregorian', hourCycle: first });",
  },
  {
    id: 'a spread of options',
    source:
      "declare const base: object;\nnew Intl.Locale('en', { ...base, calendar: 'gregorian' });",
  },
  {
    id: 'a tag the code does not write, with invalid options',
    source: "declare const tag: string;\nnew Intl.Locale(tag, { calendar: 'gregorian' });",
  },
  {
    id: 'a tag the code does not write, with valid options',
    source: "declare const tag: string;\nnew Intl.Locale(tag, { hourCycle: 'h23' });",
  },
];

/** What the tag alone throws, as it did before the options were read. */
const WRONG_TAG: readonly Row[] = [
  { id: 'a tag with an underscore', source: "new Intl.Locale('en_US');" },
  {
    id: 'a tag with an underscore and valid options',
    source: "new Intl.Locale('en_US', { hourCycle: 'h23' });",
  },
  { id: 'no tag', source: 'new Intl.Locale();' },
  { id: 'a number for a tag', source: "new Intl.Locale(5, { hourCycle: 'h23' });" },
];

describe('the options of Intl.Locale the code writes', () => {
  it.each(THROWING.map((row) => [row.id, row] as const))('reports %s as a throw', (_id, row) => {
    expect(throwsOf(row)).toBe(true);
  });

  it.each(UNPROVEN.map((row) => [row.id, row] as const))('leaves %s unreported', (_id, row) => {
    expect(throwsOf(row)).toBe(false);
  });

  it.each(WRONG_TAG.map((row) => [row.id, row] as const))(
    'still reports %s as a throw',
    (_id, row) => {
      expect(throwsOf(row)).toBe(true);
    },
  );
});

/** Whether the taker of `Intl.Locale` answers that the `new` of the source throws. */
function throwsOf(row: Row): boolean {
  using api = openTypeScript();
  using parsed = parseModule(api, 'locale-options.ts', row.source);
  const declarations = new Map<string, Expression>();
  for (const statement of parsed.sourceFile.statements) {
    if (!isVariableStatement(statement)) {
      continue;
    }
    for (const each of statement.declarationList.declarations) {
      if (isIdentifier(each.name) && each.initializer !== undefined) {
        declarations.set(each.name.text, each.initializer);
      }
    }
  }
  const made = constructionIn(parsed.sourceFile);
  const taker = LOCALE_TAKERS.get('Intl.Locale');
  if (taker === undefined || made === undefined) {
    throw new Error('The fixture is a new expression of Intl.Locale.');
  }
  return taker(
    made.arguments ?? [],
    row.resolved === true ? (name) => declarations.get(name.text) : undefined,
  );
}

/** The first `new` expression of a source, past the declarations of its constants. */
function constructionIn(node: Node): NewExpression | undefined {
  return isNewExpression(node) ? node : node.forEachChild(constructionIn);
}
