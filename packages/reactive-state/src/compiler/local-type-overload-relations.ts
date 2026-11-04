import {
  factory,
  isInterfaceDeclaration,
  isMethodSignatureDeclaration,
  isPropertySignatureDeclaration,
  type Node,
  type TypeElement,
  type TypeLiteralNode,
} from 'typescript/ast';

import { mergedHeritageDeclarations } from './local-type-aliases.ts';
import type { TypeReading } from './local-type-environment.ts';
import { memberName } from './local-type-weak-objects.ts';

/** Which written overloads of a source method may meet a method or property requirement. */

type Compare = (source: TypeReading, target: TypeReading) => boolean | undefined;
type Source = TypeReading & { readonly type: TypeLiteralNode };

/**
 * A non-inference requirement is met by any written overload of a source method, as TypeScript's
 * relation is: each overload, alone in a member list and its own environment, is compared with the
 * requirement alone. `undefined` where the requirement is no method or property, or the sources
 * hold fewer than two overloads of the name.
 */
export function overloadedMemberMatch(
  sources: readonly Source[],
  pattern: TypeReading,
  required: { readonly member: TypeElement; readonly name: string },
  compare: Compare,
): { readonly matches: boolean | undefined } | undefined {
  const { member, name } = required;
  if (!isMethodSignatureDeclaration(member) && !isPropertySignatureDeclaration(member)) return;
  const overloads = effectiveSources(sources, name).flatMap((source) => {
    return source.type.members
      .filter((each) => isMethodSignatureDeclaration(each) && memberName(each) === name)
      .map((each) => ({ ...source, type: factory.createTypeLiteralNode([each]) }));
  });
  if (overloads.length < 2) return undefined;
  const expected = { ...pattern, type: factory.createTypeLiteralNode([member]) };
  let matches: boolean | undefined = false;
  for (const overload of overloads) {
    const result = compare(overload, expected);
    if (result === true) return { matches: true };
    if (result === undefined) matches = undefined;
  }
  return { matches };
}

/** The first declared member hides inherited declarations; merged bodies still share one family. */
function effectiveSources(sources: readonly Source[], name: string): readonly Source[] {
  const selected = sources.find((source) =>
    source.type.members.some((member) => memberName(member) === name),
  );
  if (selected === undefined) return [];
  const declaration = selected.type.members.find((member) => memberName(member) === name)?.parent;
  if (declaration === undefined) return [selected];
  const family = new Set<Node>(
    isInterfaceDeclaration(declaration)
      ? mergedHeritageDeclarations(declaration, true)
      : [declaration],
  );
  return sources.filter((source) =>
    source.type.members.some((member) => memberName(member) === name && family.has(member.parent)),
  );
}
