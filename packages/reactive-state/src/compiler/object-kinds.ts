import {
  isCallSignatureDeclaration,
  isConstructSignatureDeclaration,
  isIdentifier,
  isIndexSignatureDeclaration,
  isMethodSignatureDeclaration,
  isPropertySignatureDeclaration,
  isStringLiteral,
  SyntaxKind,
  type TypeElement,
} from 'typescript/ast';

/**
 * What an object's type tells of the kind of JSON its values are of, by its members alone: the
 * object's kind where none of the language's other values satisfies it; none where they may — as
 * TypeScript reads a type by what it holds, `{}`, `interface Selection {}` and `{ length: number }`
 * take text as well, `{ name: string }` a function, `{ description?: string }` a symbol — or where
 * it is called (`{ (): string }`), a function's.
 */

/** What an object's type tells of its values' kind, by its members (`membersKind`). */
export type MembersKind = 'called' | 'object' | 'shared';

/**
 * A member of an object's type, as what tells the object's kind reads it: the name it is written
 * of, as text — none of a computed one, or of a number — whether it may be left out, whether it is
 * an index of text (`[key: string]: T`), and whether it is a call or a construction of the object.
 */
export interface MemberShape {
  readonly called: boolean;
  readonly name: string | undefined;
  readonly optional: boolean;
  readonly textIndex: boolean;
}

/**
 * The names the language's text, numbers, booleans, symbols, integers of `bigint`, arrays, functions
 * and objects hold of themselves, which a type of members of those names they satisfy as well as an
 * object does.
 */
const SHARED_NAMES: ReadonlySet<string> = new Set(
  [
    String.prototype,
    Number.prototype,
    Boolean.prototype,
    Symbol.prototype,
    BigInt.prototype,
    Array.prototype,
    Function.prototype,
    Object.prototype,
  ].flatMap((prototype) => Object.getOwnPropertyNames(prototype)),
);

/** A name of an index: digits alone. */
const INDEX = /^\d+$/u;

/** What `members` tell of the kind of the values of a type of them (`shapesKind`). */
export function membersKind(members: readonly TypeElement[]): MembersKind {
  return shapesKind(members.map((member) => shapeOf(member)));
}

/**
 * What members of `shapes` tell of the kind of the values of a type of them: `called` where one is
 * a call or a construction of it, which a function's is; `object` where one is a member of a name of
 * its own, none of the language's other values holds (`SHARED_NAMES`), that may not be left out, or
 * an index of text — which no text, number, array or function has — or where each may be left out
 * and none is of a shared name, which TypeScript holds a value to have one of (`{ id?: string }`);
 * `shared` else — none, a number's index (`[index: number]: string`), which text and arrays have, or
 * one left out beside one of a shared name: `{ id?: string; length?: number }` takes text.
 */
export function shapesKind(shapes: readonly MemberShape[]): MembersKind {
  let kind: MembersKind = 'shared';
  let weak = shapes.length > 0;
  for (const { called, name, optional, textIndex } of shapes) {
    if (called) {
      return 'called';
    }
    const owned = name !== undefined && isOwnName(name);
    if (textIndex || (owned && !optional)) {
      kind = 'object';
    }
    weak &&= owned && optional;
  }
  return weak ? 'object' : kind;
}

/** What `member` is, as `shapesKind` reads it. */
export function shapeOf(member: TypeElement): MemberShape {
  const named = isPropertySignatureDeclaration(member) || isMethodSignatureDeclaration(member);
  const name =
    named && (isIdentifier(member.name) || isStringLiteral(member.name))
      ? member.name.text
      : undefined;
  return {
    called: isCallSignatureDeclaration(member) || isConstructSignatureDeclaration(member),
    name,
    optional: named && member.postfixToken?.kind === SyntaxKind.QuestionToken,
    textIndex: isTextIndex(member),
  };
}

/** Whether `member` is an index of text, `[key: string]: T`. */
function isTextIndex(member: TypeElement): boolean {
  if (!isIndexSignatureDeclaration(member)) {
    return false;
  }
  const [key] = member.parameters;
  return key?.type?.kind === SyntaxKind.StringKeyword;
}

/**
 * Whether an object's member of the name `text` is one none of the language's other values holds:
 * none of `SHARED_NAMES`, nor an index, `0` or `'0'`, which text and arrays hold as well.
 */
export function isOwnName(text: string): boolean {
  return !SHARED_NAMES.has(text) && !INDEX.test(text);
}
