import {
  factory,
  type InterfaceDeclaration,
  isExpressionWithTypeArguments,
  isIdentifier,
  isInterfaceDeclaration,
  isTypeLiteralNode,
  isFunctionTypeNode,
  isConstructorTypeNode,
  isIntersectionTypeNode,
  type TypeLiteralNode,
  isTypeReferenceNode,
  SyntaxKind,
} from 'typescript/ast';

import { localTypeBinding, mergedHeritageDeclarations } from './local-type-aliases.ts';
import { type TypeReading, typeBindingKey } from './local-type-environment.ts';
import { getterMemberTypes, namedMemberTypes, selectedMemberTypes } from './local-type-members.ts';
import { qualifiedLocalTypeBinding } from './local-type-namespaces.ts';

/** Written interface member selections retain actual arguments in their original lexical scopes. */

type Operands = (reading: TypeReading) => readonly TypeReading[];
interface MemberStep {
  readonly values: readonly TypeReading[];
  readonly bases: readonly TypeReading[];
}

/** Interface fields and explicit heritage, with repeated inherited argument environments cut. */
export function interfaceMemberReadings(
  at: TypeReading,
  key: string,
  operands: Operands,
): readonly TypeReading[] | undefined {
  if (interfaceDeclaration(at.type) === undefined) return undefined;
  const values: TypeReading[] = [];
  const pending = [at];
  for (let reading = pending.pop(); reading !== undefined; reading = pending.pop()) {
    const selected = interfaceStep(reading, key);
    values.push(...selected.values);
    for (const base of selected.bases) pending.push(...operands(base));
  }
  return values;
}

/**
 * Explicit names across all merged declarations precede any inherited shape; a signature or a
 * computed name the reader cannot read leaves the inherited member possible beside its own value.
 */
function interfaceStep(at: TypeReading, key: string): MemberStep {
  const declaration = interfaceDeclaration(at.type);
  if (declaration === undefined) return { bases: [], values: literalMembers(at, key) };
  const values: TypeReading[] = [];
  const bases: TypeReading[] = [];
  const named: TypeReading[] = [];
  const getters: TypeReading[] = [];
  let hasNamed = false;
  for (const declared of mergedHeritageDeclarations(declaration, true)) {
    if (!isInterfaceDeclaration(declared)) continue;
    const bound = interfaceEnvironment(at, declared);
    if (bound === undefined) continue;
    const shape = factory.createTypeLiteralNode(declared.members);
    getters.push(...(getterMemberTypes(shape, key)?.map((type) => ({ ...bound, type })) ?? []));
    const own = namedMemberTypes(shape, key);
    if (own !== undefined) {
      hasNamed = true;
      named.push(...own.map((member) => ({ ...bound, type: member })));
    }
    values.push(...literalMembers({ ...bound, type: shape }, key));
    if (own === undefined) {
      const heritage = declared.heritageClauses?.find(
        (clause) => clause.token === SyntaxKind.ExtendsKeyword,
      );
      bases.push(...(heritage?.types.map((type) => ({ ...bound, type })) ?? []));
    }
  }
  if (getters.length > 0) return { bases: [], values: getters };
  return hasNamed ? { bases: [], values: named } : { bases, values };
}

/** A selected original member node, never a synthetic node's lexical scope. */
function literalMembers(at: TypeReading, key: string): readonly TypeReading[] {
  if (isExpressionWithTypeArguments(at.type)) return [];
  return selectedMemberTypes(at.type, [key])?.map((type) => ({ ...at, type })) ?? [];
}

/** Only interface references establish interface fields; classes and imports retain their boundary. */
function interfaceDeclaration(type: TypeReading['type']): InterfaceDeclaration | undefined {
  let binding;
  if (isTypeReferenceNode(type)) {
    binding = isIdentifier(type.typeName)
      ? localTypeBinding(type.typeName)
      : qualifiedLocalTypeBinding(type.typeName);
  } else if (isExpressionWithTypeArguments(type) && isIdentifier(type.expression)) {
    binding = localTypeBinding(type.expression);
  }
  return binding !== undefined && binding !== null && isInterfaceDeclaration(binding)
    ? binding
    : undefined;
}

/** Actual arguments use caller readings; defaults can refer to preceding declared parameters. */
function interfaceEnvironment(
  at: TypeReading,
  declaration: InterfaceDeclaration,
): TypeReading | undefined {
  if (!isTypeReferenceNode(at.type) && !isExpressionWithTypeArguments(at.type)) return undefined;
  const bindings = new Map(at.bindings);
  const aliases = new Set(at.aliases);
  const parameters = declaration.typeParameters ?? [];
  for (const [index, parameter] of parameters.entries()) {
    const argument = at.type.typeArguments?.[index];
    const type = argument ?? parameter.defaultType;
    if (type === undefined) bindings.delete(parameter);
    else
      bindings.set(
        parameter,
        argument === undefined ? { aliases, bindings, type } : { ...at, type },
      );
  }
  const key = typeBindingKey(declaration, bindings);
  if (aliases.has(key)) return undefined;
  aliases.add(key);
  return { ...at, aliases, bindings };
}

interface InterfaceShapes {
  readonly sources: readonly TypeReading[];
  readonly unknown: boolean;
}

/** An interface's shapes in the order TypeScript lists their signatures: own, then each base's. */
interface InterfaceSignatureShapes extends InterfaceShapes {
  /** How many of `sources` precede the last part whose signatures cannot be read, if any. */
  readonly unknownAfter?: number | undefined;
}

const INTERFACE_SHAPES = new WeakMap<InterfaceDeclaration, TypeLiteralNode>();

/** Written interface bodies precede inherited signatures, retaining each original argument environment. */
export function interfaceShapeReadings(
  at: TypeReading,
  operands: Operands,
): InterfaceSignatureShapes | undefined {
  if (interfaceDeclaration(at.type) === undefined) return undefined;
  const sources: TypeReading[] = [];
  // `null` holds the place of a base read as nothing, where its signatures would be listed.
  const pending: (TypeReading | null)[] = [at];
  let unknownAfter: number | undefined;
  for (let reading = pending.pop(); reading !== undefined; reading = pending.pop()) {
    if (reading === null) {
      unknownAfter = sources.length;
      continue;
    }
    const part = interfaceShapesStep(reading);
    sources.push(...part.sources);
    if (part.unknown) unknownAfter = sources.length;
    for (const base of part.bases.toReversed()) {
      const resolved = operands(base);
      pending.push(...(resolved.length === 0 ? [null] : resolved.toReversed()));
    }
  }
  return { sources, unknown: unknownAfter !== undefined, unknownAfter };
}

/** One inherited declaration is expanded once in its own bound environment, before following bases. */
function interfaceShapesStep(
  at: TypeReading,
): InterfaceShapes & { readonly bases: readonly TypeReading[] } {
  const declaration = interfaceDeclaration(at.type);
  if (declaration === undefined)
    return { bases: [], sources: writtenShape(at) ? [at] : [], unknown: !writtenShape(at) };
  const sources: TypeReading[] = [];
  const bases: TypeReading[] = [];
  let unknown = false;
  for (const declared of mergedHeritageDeclarations(declaration, true)) {
    if (!isInterfaceDeclaration(declared)) continue;
    const bound = interfaceEnvironment(at, declared);
    if (bound === undefined) {
      unknown = true;
      continue;
    }
    sources.push({ ...bound, type: interfaceShape(declared) });
    const heritage = declared.heritageClauses?.find(
      (clause) => clause.token === SyntaxKind.ExtendsKeyword,
    );
    bases.push(...(heritage?.types.map((type) => ({ ...bound, type })) ?? []));
  }
  return { sources, bases, unknown };
}

/** Existing literal, callable and intersection readers retain their own syntax-specific handling. */
function writtenShape(reading: TypeReading): boolean {
  const { type } = reading;
  return (
    isTypeLiteralNode(type) ||
    isFunctionTypeNode(type) ||
    isConstructorTypeNode(type) ||
    isIntersectionTypeNode(type)
  );
}

/** Stable containers retain original member nodes without replacing their lexical declaration parents. */
function interfaceShape(declaration: InterfaceDeclaration): TypeLiteralNode {
  const previous = INTERFACE_SHAPES.get(declaration);
  if (previous !== undefined) return previous;
  const type = factory.createTypeLiteralNode(declaration.members);
  INTERFACE_SHAPES.set(declaration, type);
  return type;
}

/** What one written shape's last matching signature gives; none where the shape has no such signature. */
export type ShapeSignature<Result> = { readonly result: Result | undefined } | undefined;

interface SignatureStep {
  readonly reading: TypeReading;
  /** Whether an interface's shape gave the reading, rather than a written type outside interfaces. */
  readonly inherited: boolean;
}

/** A step of the walk, or `null` where signatures the reader cannot read are listed. */
type Listed = SignatureStep | null;

/**
 * The last signature `read` finds, in the order TypeScript lists signatures: an interface's own and
 * then each base's, an intersection's members in turn. One read after the last part the reader cannot
 * read is TypeScript's last; where none follows that part, the written shapes outside interfaces keep
 * the reading they give, and interfaces give none.
 */
export function lastSignatureOf<Result>(
  at: TypeReading,
  operands: Operands,
  read: (reading: TypeReading) => ShapeSignature<Result>,
): Result | undefined {
  let last: ShapeSignature<Result>;
  let written: ShapeSignature<Result>;
  let unread = false;
  const pending: Listed[] = [{ inherited: false, reading: at }];
  for (let step = pending.pop(); step !== undefined; step = pending.pop()) {
    if (step === null) {
      last = undefined;
      unread = true;
      continue;
    }
    const listed = listedSteps(step, operands);
    if (listed !== undefined) {
      pending.push(...listed.toReversed());
      continue;
    }
    const found = read(step.reading);
    if (found === undefined) continue;
    last = found;
    if (!step.inherited) written = found;
  }
  return (unread && last === undefined ? written : last)?.result;
}

/**
 * What an interface or an intersection lists, in signature order — `null` where an interface lists
 * signatures the reader cannot read — and none of a shape that is neither.
 */
function listedSteps(step: SignatureStep, operands: Operands): readonly Listed[] | undefined {
  const { inherited, reading } = step;
  const interfaces = interfaceShapeReadings(reading, operands);
  if (interfaces !== undefined) {
    const steps = interfaces.sources.map((source) => inheritedStep(source));
    if (interfaces.unknownAfter !== undefined) steps.splice(interfaces.unknownAfter, 0, null);
    return steps;
  }
  if (!isIntersectionTypeNode(reading.type)) return undefined;
  const members = reading.type.types.flatMap((member) => operands({ ...reading, type: member }));
  return members.map((member): SignatureStep => ({ inherited, reading: member }));
}

/** A shape an interface's walk gave. */
function inheritedStep(reading: TypeReading): Listed {
  return { inherited: true, reading };
}
