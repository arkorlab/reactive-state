import { isIdentifier, isTypeReferenceNode } from 'typescript/ast';

import { localTypeBinding } from './local-type-aliases.ts';
import { qualifiedBuiltinName } from './local-type-builtins.ts';
import { typeReadingKey, type TypeReading } from './local-type-environment.ts';
import { memberReadings } from './local-type-selections.ts';
import { finiteIndexKeys } from './local-type-template-keys.ts';

/** Finite native intrinsic string mappings keep their original source and argument environments. */

const NAMES = new Set(['Capitalize', 'Lowercase', 'Uncapitalize', 'Uppercase']);
const ACTIVE = new Set<string>();

/** Additional mapping keys preserve intersections instead of treating them as alternatives. */
export function intrinsicIndexReadings(
  index: TypeReading,
  objects: readonly TypeReading[],
  operands: (reading: TypeReading, intersections?: boolean) => readonly TypeReading[],
): readonly TypeReading[] {
  const mapped = new Set<TypeReading>();
  const keys = finiteIndexKeys(
    index,
    (reading) => operands(reading, false),
    (reading, words) => {
      const result = intrinsicStringWords(reading, words);
      if (result !== undefined) mapped.add(reading);
      return result;
    },
  );
  if (keys === undefined || mapped.size === 0) return [];
  return objects.flatMap((object) =>
    keys.flatMap((key) => memberReadings(object, [key], operands)),
  );
}

/** An unshadowed native case mapping's original argument, without expanding any words. */
export function intrinsicStringArgument(
  at: TypeReading,
): { readonly name: string; readonly reading: TypeReading } | undefined {
  const { type } = at;
  if (!isTypeReferenceNode(type) || type.typeArguments?.length !== 1) return undefined;
  const { typeName } = type;
  let name: string | undefined;
  if (isIdentifier(typeName)) {
    if (localTypeBinding(typeName) === undefined) name = typeName.text;
  } else {
    name = qualifiedBuiltinName(typeName);
  }
  if (name === undefined || !NAMES.has(name)) return undefined;
  const argument = type.typeArguments[0];
  if (argument === undefined) return undefined;
  return { name, reading: { ...at, type: argument } };
}

/** Only an unshadowed native mapping of completely known words contributes new literal keys. */
function intrinsicStringWords(
  at: TypeReading,
  words: (reading: TypeReading) => readonly string[] | undefined,
): readonly string[] | undefined {
  const selected = intrinsicStringArgument(at);
  if (selected === undefined) return undefined;
  const key = typeReadingKey(at);
  if (ACTIVE.has(key)) return undefined;
  ACTIVE.add(key);
  try {
    return words(selected.reading)?.map((word) => mappedWord(selected.name, word));
  } finally {
    ACTIVE.delete(key);
  }
}

/** TypeScript 7.1's finite native case mappings use the first Unicode character for initial casing. */
function mappedWord(name: string, word: string): string {
  if (name === 'Uppercase') return word.toUpperCase();
  if (name === 'Lowercase') return word.toLowerCase();
  const [first = ''] = word;
  const initial = name === 'Capitalize' ? first.toUpperCase() : first.toLowerCase();
  return initial + word.slice(first.length);
}
