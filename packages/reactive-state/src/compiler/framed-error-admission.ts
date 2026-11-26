/**
 * Whether a declared type admits an Error: whether a value of it may be one, as TypeScript's
 * checker reads the type (`framedChecked`), past aliases, generics, mapped and conditional types,
 * utilities and imports alike. A value of a type that admits one, which the compile cannot read,
 * may then be an Error, while a type that excludes one is trusted. A type the checker cannot give,
 * or a question it cannot answer, admits one.
 */

import { type Node, SyntaxKind, type TypeNode } from 'typescript/ast';
import {
  type Checker,
  IndexKind,
  SignatureKind,
  type Symbol,
  SymbolFlags,
  type Type,
  TypeFlags,
} from 'typescript/sync';

import { type CheckerGlobals, framedChecked } from './type-checker.ts';

/** A whole index into an array or a tuple. */
const INDEX = /^(?:0|[1-9]\d*)$/u;

/** Whether TypeScript's flags hold any of `wanted`. */
function flagged(flags: number, ...wanted: readonly number[]): boolean {
  // eslint-disable-next-line no-bitwise -- TypeScript records a type's kinds in these flags.
  return wanted.some((each) => (flags & each) !== 0);
}

/** A checker and the global types its questions read. */
export interface AdmissionChecker {
  readonly checker: Checker;
  readonly globals: CheckerGlobals;
}

/**
 * Whether what a value of the declared type holds at a member path admits an Error
 * (`framedAdmittedAt`): none declared does, and so does one the checker cannot read.
 */
export function framedMemberAdmitted(type: TypeNode | undefined, keys: readonly string[]): boolean {
  if (type === undefined) return true;
  const checked = framedChecked(type);
  if (checked === undefined) return true;
  const declared = checked.checker.getTypeFromTypeNode(checked.node as TypeNode);
  return framedAdmittedAt(checked, declared, keys);
}

/**
 * Whether what a value of the type holds at the keys may be an Error: each step a property's type,
 * an array's or a tuple's element, or what an index gives, of each member of a union but `null`
 * and `undefined`, whose member read throws; a step the checker cannot take, or one into a type
 * that holds anything, may hold one.
 */
export function framedAdmittedAt(
  at: AdmissionChecker,
  type: Type,
  keys: readonly string[],
): boolean {
  const [key, ...rest] = keys;
  if (key === undefined) return admits(at, type);
  // Reading a member of `null` or `undefined` throws: such an arm answers nothing at a key.
  if (nullish(type)) return false;
  if (open(type)) return true;
  if (type.isUnionType()) return type.getTypes().some((each) => framedAdmittedAt(at, each, keys));
  const { checker } = at;
  const member =
    checker.getTypeOfPropertyOfType(type, key) ??
    (INDEX.test(key) ? checker.getIndexTypeOfType(type, IndexKind.Number) : undefined) ??
    checker.getIndexTypeOfType(type, IndexKind.String);
  return member === undefined || framedAdmittedAt(at, member, rest);
}

/** `null`, `undefined` or `void`, of which no member is read. */
function nullish(type: Type): boolean {
  return flagged(type.flags, TypeFlags.Null, TypeFlags.Undefined, TypeFlags.Void);
}

/**
 * A type that may hold anything: `any`, `unknown`, one the checker cannot give, and one it defers
 * until its type parameters are known (`deferred`).
 */
function open(type: Type): boolean {
  return (
    flagged(type.flags, TypeFlags.Any, TypeFlags.Unknown) || type.isErrorType() || deferred(type)
  );
}

/**
 * A type the checker defers until its type parameters are known: a type parameter, an indexed
 * access, a conditional or a substitution type, a `keyof` of one, and a template or a string
 * mapping over one; a union or an intersection with a member that is. What it holds once they are
 * is unknown here, so it may be an Error, or a member an Error's fits.
 */
function deferred(type: Type): boolean {
  let at = type;
  while (at.isStringMappingType()) at = at.getTarget();
  if (flagged(at.flags, TypeFlags.InstantiableNonPrimitive, TypeFlags.Index)) return true;
  return (
    (at.isTemplateLiteralType() || at.isUnionType() || at.isIntersectionType()) &&
    at.getTypes().some((each) => deferred(each))
  );
}

/**
 * Whether a value of the type may be an Error: one of an open type does; one of a union where a
 * member admits one; one of a type each value of which is an Error (`errorLike`); and one of a type
 * an Error fits (`errorFits`). `never` holds none.
 */
function admits(at: AdmissionChecker, type: Type): boolean {
  if (open(type)) return true;
  if (type.isUnionType()) return type.getTypes().some((each) => admits(at, each));
  if (flagged(type.flags, TypeFlags.Never)) return false;
  return errorLike(at, type) || errorFits(at, type);
}

/**
 * Whether each value of a type may be an Error: one of the language's or the platform's Error
 * types, a class or an interface that derives one, or one whose base the checker cannot resolve
 * (an import it cannot read), as the base may be an Error type; an intersection where a member is,
 * a union where every member is.
 */
function errorLike(
  at: AdmissionChecker,
  type: Type,
  path: ReadonlySet<number> = new Set(),
): boolean {
  if (open(type)) return true;
  // A guard against a cycle of bases along one path; each branch reads its members afresh.
  if (path.has(type.id)) return false;
  const within = new Set(path).add(type.id);
  if (type.isUnionType()) return type.getTypes().every((each) => errorLike(at, each, within));
  if (type.isIntersectionType()) return type.getTypes().some((each) => errorLike(at, each, within));
  const target = type.isTypeReference() ? type.getTarget() : type;
  const { errorFamily } = at.globals;
  if (errorFamily.has(target.id) || errorFamily.has(type.id)) return true;
  if (unresolvedBase(at.checker, target)) return true;
  return (target.getBaseTypes() ?? []).some((base) => errorLike(at, base, within));
}

/**
 * Whether a class or an interface is written with a base the checker cannot resolve, beside others
 * it can or alone: an import it cannot read, an ambient declaration outside its program. A base
 * the checker cannot resolve leaves no base type behind, only the written entry.
 */
function unresolvedBase(checker: Checker, type: Type): boolean {
  const declarations = type.getSymbol()?.declarations ?? [];
  return declarations.some((handle) => {
    const node = handle.resolve() as
      | {
          readonly heritageClauses?: readonly {
            readonly token: SyntaxKind;
            readonly types: readonly TypeNode[];
          }[];
        }
      | undefined;
    return (node?.heritageClauses ?? [])
      .filter((clause) => clause.token === SyntaxKind.ExtendsKeyword)
      .some((clause) => clause.types.some((entry) => open(checker.getTypeFromTypeNode(entry))));
  });
}

/**
 * Whether an Error fits a type: the checker's assignability, else, for an object type, member by
 * member, without the two rules of assignability that read no value: a weak type's (each of its
 * members optional) demand of a member in common, and an interface's lack of an implicit index
 * signature. Each required member must be one an Error has, with a type its own fits; an optional
 * one, where an Error has it; a string index, each member every Error has; and a member only the
 * class's own instances hold (`ownOnly`), a call or a construct signature, an array and a tuple
 * fit none. An intersection is fitted where each member is.
 */
function errorFits(at: AdmissionChecker, type: Type): boolean {
  const { checker } = at;
  const { error } = at.globals;
  if (checker.isTypeAssignableTo(error, type)) return true;
  if (type.isIntersectionType())
    return type.getTypes().every((each) => errorLike(at, each) || errorFits(at, each));
  if (!type.isObjectType() || checker.isArrayType(type) || checker.isTupleType(type)) return false;
  if (
    checker.getSignaturesOfType(type, SignatureKind.Call).length > 0 ||
    checker.getSignaturesOfType(type, SignatureKind.Construct).length > 0
  )
    return false;
  return membersFit(checker, error, type) && indexesFit(checker, error, type);
}

/** Whether each member of a type is one an Error fits, as `errorFits` reads it. */
function membersFit(checker: Checker, error: Type, type: Type): boolean {
  return checker.getPropertiesOfType(type).every((property) => {
    if (ownOnly(property)) return false;
    const own = checker.getPropertyOfType(error, property.name);
    if (own === undefined) return flagged(property.flags, SymbolFlags.Optional);
    const wanted = checker.getTypeOfSymbol(property);
    return open(wanted) || checker.isTypeAssignableTo(checker.getTypeOfSymbol(own), wanted);
  });
}

/** Whether each member every Error has fits each string index of a type. */
function indexesFit(checker: Checker, error: Type, type: Type): boolean {
  const required = checker
    .getPropertiesOfType(error)
    .filter((own) => !flagged(own.flags, SymbolFlags.Optional))
    .map((own) => checker.getTypeOfSymbol(own));
  return checker
    .getIndexInfosOfType(type)
    .filter((info) => flagged(info.keyType.flags, TypeFlags.String, TypeFlags.Any))
    .every((info) => {
      return (
        open(info.valueType) ||
        required.every((each) => checker.isTypeAssignableTo(each, info.valueType))
      );
    });
}

/** A member only a class's own instances hold: `private`, `protected` or `#name`. */
function ownOnly(property: Symbol): boolean {
  if (property.escapedName.startsWith('__#')) return true;
  const declaration = property.valueDeclaration?.resolve() as
    | { readonly modifiers?: readonly Node[] }
    | undefined;
  return (declaration?.modifiers ?? []).some(
    (each) => each.kind === SyntaxKind.PrivateKeyword || each.kind === SyntaxKind.ProtectedKeyword,
  );
}
