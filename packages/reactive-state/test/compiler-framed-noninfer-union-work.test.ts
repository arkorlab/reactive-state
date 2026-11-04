import {
  isConditionalTypeNode,
  isIdentifier,
  isTypeAliasDeclaration,
  isTypeReferenceNode,
  SyntaxKind,
  type TypeAliasDeclaration,
} from 'typescript/ast';
import { describe, expect, it } from 'vitest';

import {
  boundTypeBody,
  initialTypeReading,
  type TypeReading,
} from '../src/compiler/local-type-environment.ts';
import { inferPattern } from '../src/compiler/local-type-inference.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/** Equivalent primitive arms add no new non-inference obligation or captured environment. */
const LIMITS = {
  small: 4,
  medium: 6,
  large: 8,
  perField: 16,
  overhead: 16,
  probe: 20_000,
} as const;
const MODES = ['same', 'false-first', 'false-last', 'unknown-first', 'unknown-last'] as const;
type Mode = (typeof MODES)[number];
const EXPECTED: Readonly<Record<Mode, boolean | undefined>> = {
  same: true,
  'false-first': false,
  'false-last': false,
  'unknown-first': undefined,
  'unknown-last': undefined,
};

/** A flat pair with a different or unresolved obligation at either end of the LIFO worklist. */
function sourceOf(fields: number, mode: Mode): string {
  const left: string[] = [];
  const right: string[] = [];
  for (let index = 0; index < fields; index++) {
    const first = index === 0;
    const last = index === fields - 1;
    const unknown = (mode === 'unknown-first' && first) || (mode === 'unknown-last' && last);
    const wrong = (mode === 'false-first' && first) || (mode === 'false-last' && last);
    left.push(`f${index}:${unknown ? 'unknown' : 'V'}`);
    right.push(`f${index}:${wrong ? 'string' : 'V'}`);
  }
  return `type V=number|number;type A={${left.join(';')}};type B={${right.join(';')}};type Check=A extends B?true:false;`;
}

/** Actual original alias binding and comparator callbacks count matcher work without instrumenting production. */
function matchedComparison(source: string) {
  using api = openTypeScript();
  using parsed = parseModule(api, 'noninfer-union-work.ts', source);
  const declarations = new Map<string, TypeAliasDeclaration>();
  for (const statement of parsed.sourceFile.statements)
    if (isTypeAliasDeclaration(statement)) declarations.set(statement.name.text, statement);
  const conditional = declarations.get('Check')?.type;
  if (conditional === undefined || !isConditionalTypeNode(conditional))
    throw new Error('missing Check');
  let resolutions = 0;
  const resolve = (at: TypeReading): TypeReading | undefined => {
    resolutions += 1;
    if (resolutions > LIMITS.probe) throw new Error('bounded noninfer resolver probe exceeded');
    let reading = at;
    while (isTypeReferenceNode(reading.type) && isIdentifier(reading.type.typeName)) {
      const declaration = declarations.get(reading.type.typeName.text);
      if (declaration === undefined) return reading;
      const bound = boundTypeBody(declaration, reading.type, reading);
      if (bound === undefined) return undefined;
      reading = { ...bound, type: declaration.type };
    }
    return reading;
  };
  const result = inferPattern(
    initialTypeReading(conditional.checkType),
    initialTypeReading(conditional.extendsType),
    resolve,
    (checked, pattern) => {
      const kinds = new Set([SyntaxKind.NumberKeyword, SyntaxKind.StringKeyword]);
      return kinds.has(checked.type.kind) && kinds.has(pattern.type.kind)
        ? checked.type.kind === pattern.type.kind
        : undefined;
    },
  );
  return { result, resolutions };
}

describe('noninfer primitive union work', () => {
  it.each(
    [LIMITS.small, LIMITS.medium, LIMITS.large].flatMap((fields) =>
      MODES.map((mode) => ({ fields, mode })),
    ),
  )('$fields $mode', ({ fields, mode }) => {
    const { result, resolutions } = matchedComparison(sourceOf(fields, mode));

    expect(result.matches).toBe(EXPECTED[mode]);
    expect(resolutions).toBeLessThanOrEqual(fields * LIMITS.perField + LIMITS.overhead);
  });

  it.each([
    { source: 'type S=number|string;type Check=S extends number?true:false;', expected: false },
    {
      source: 'type S=number|string;type T=number|string;type Check=S extends T?true:false;',
      expected: true,
    },
    { source: 'type T=string|number;type Check=number extends T?true:false;', expected: true },
    {
      source: 'type S=number|unknown;type Check=S extends number?true:false;',
      expected: undefined,
    },
  ])('retains source and target obligations $source', ({ source, expected }) => {
    expect(matchedComparison(source).result.matches).toBe(expected);
  });
});
