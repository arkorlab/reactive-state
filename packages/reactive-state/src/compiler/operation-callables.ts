import {
  isCallSignatureDeclaration,
  isIdentifier,
  isImportTypeNode,
  isParenthesizedTypeNode,
  isParameterDeclaration,
  isQualifiedName,
  isThisTypeNode,
  isTypeAliasDeclaration,
  isTypeParameterDeclaration,
  isTypePredicateNode,
  isTypeQueryNode,
  isTypeLiteralNode,
  isTypeOperatorNode,
  isTypeReferenceNode,
  isVariableStatement,
  type CallSignatureDeclaration,
  type EntityName,
  type Node,
  type ParameterDeclaration,
  type QualifiedName,
  SyntaxKind,
  type TypeNode,
} from 'typescript/ast';

import { globalOf } from './bounded.ts';
import { failIn } from './errors.ts';
import { localTypeBinding } from './local-type-aliases.ts';
import { namespaceBound, qualifiedBuiltinName } from './local-type-builtins.ts';
import type { ParsedModule } from './modules.ts';

/** Finite written operation call signatures, with generic syntax kept only in its own scope. */

export interface OperationCallable {
  readonly count: number;
  /** A generic overload set retains its binders and each input/result relationship. */
  readonly written?: readonly OperationSignature[];
}

interface OperationSignature {
  readonly head: string;
  readonly answer: string;
}

/** Direct callable annotations and whole nongeneric local aliases retain finite overload order. */
export function operationCallables(parsed: ParsedModule): ReadonlyMap<string, OperationCallable> {
  const found = new Map<string, OperationCallable>();
  const fail = failIn(parsed.sourceFile, parsed.name);
  for (const statement of parsed.sourceFile.statements) {
    if (
      !isVariableStatement(statement) ||
      statement.modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword) !== true
    )
      continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!isIdentifier(declaration.name) || declaration.type === undefined) continue;
      const callable = describeCallable(declaration.type, fail);
      if (callable !== undefined) found.set(declaration.name.text, callable);
    }
  }
  return found;
}

/** A generic overload set is copied as a whole so specialization and overload order stay native. */
function describeCallable(
  type: TypeNode,
  fail: ReturnType<typeof failIn>,
): OperationCallable | undefined {
  const signatures = writtenSignatures(type);
  if (signatures === undefined || signatures.length === 0) return undefined;
  const generic = signatures.some((signature) => (signature.typeParameters?.length ?? 0) > 0);
  const written: OperationSignature[] = [];
  for (const signature of signatures) {
    const parameters = signatureParameters(signature);
    if (
      parameters.some((parameter) => isIdentifier(parameter.name) && parameter.name.text === 'this')
    )
      fail(
        'A callable server operation with a written receiver cannot carry that receiver through its asynchronous stub. Declare its value inputs as ordinary parameters.',
        signature,
      );
    if (!generic) continue;
    if (!movableGeneric(signature))
      fail(
        'A generic server-operation signature uses a type form the asynchronous stub cannot preserve in its written scope. Use its own generic parameters and unshadowed built-in types in the callable annotation.',
        signature,
      );
    written.push(genericSignature(signature, parameters));
  }
  if (generic) return { count: signatures.length, written };
  return signatures.length > 1 ? { count: signatures.length } : undefined;
}

/** A local alias keeps its original call nodes; its instantiated nongeneric overloads are inferred. */
function writtenSignatures(initial: TypeNode): readonly CallSignatureDeclaration[] | undefined {
  let type = initial;
  const seen = new Set<Node>();
  while (!seen.has(type)) {
    seen.add(type);
    if (isParenthesizedTypeNode(type)) {
      type = type.type;
      continue;
    }
    if (isTypeLiteralNode(type))
      return type.members.filter((member): member is CallSignatureDeclaration =>
        isCallSignatureDeclaration(member),
      );
    if (!isTypeReferenceNode(type) || !isIdentifier(type.typeName)) return undefined;
    const declaration = localTypeBinding(type.typeName);
    if (declaration === undefined || declaration === null || !isTypeAliasDeclaration(declaration))
      return undefined;
    type = declaration.type;
  }
  return undefined;
}

/** Direct parameter children remain available when the API omits an empty parameters array. */
function signatureParameters(signature: CallSignatureDeclaration): readonly ParameterDeclaration[] {
  const parameters: ParameterDeclaration[] = [];
  signature.forEachChild((node) => {
    if (isParameterDeclaration(node)) parameters.push(node);
  });
  return parameters;
}

/** A copied generic member names only binders it carries with it and unchanged global type names. */
function movableGeneric(signature: CallSignatureDeclaration): boolean {
  const pending: Node[] = [signature];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypePredicateNode(node)) continue;
    if (isTypeOperatorNode(node) && node.operator === SyntaxKind.UniqueKeyword) return false;
    if (isImportTypeNode(node) || isTypeQueryNode(node) || isThisTypeNode(node)) return false;
    if (isTypeReferenceNode(node) && !movableReference(node.typeName, signature)) return false;
    if (isParameterDeclaration(node) && node.initializer !== undefined) return false;
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return true;
}

/** A type parameter must be declared inside the copied signature rather than in its original container. */
function movableReference(name: EntityName, signature: CallSignatureDeclaration): boolean {
  if (isQualifiedName(name)) return movableGlobalNamespace(name);
  const binding = localTypeBinding(name);
  if (binding === undefined) return true;
  if (binding === null || !isTypeParameterDeclaration(binding)) return false;
  for (let node: Node = binding; ; node = node.parent) {
    if (node === signature) return true;
    if (node === binding.getSourceFile()) return false;
  }
}

/** Unshadowed global namespace paths keep the same type identity in the copied signature. */
function movableGlobalNamespace(name: QualifiedName): boolean {
  if (qualifiedBuiltinName(name) !== undefined) return true;
  let root = name.left;
  while (isQualifiedName(root)) root = root.left;
  return !namespaceBound(root) && globalOf(root) === root.text;
}

/** Awaiting a transported predicate produces a boolean or void result, never a synchronous narrowing. */
function genericSignature(
  signature: CallSignatureDeclaration,
  parameters: readonly ParameterDeclaration[],
): OperationSignature {
  const generics = (signature.typeParameters ?? [])
    .map((parameter) => parameter.getText())
    .join(', ');
  let answer = signature.type?.getText() ?? 'unknown';
  if (signature.type !== undefined && isTypePredicateNode(signature.type))
    answer = signature.type.assertsModifier === undefined ? 'boolean' : 'void';
  const prefix = generics === '' ? '' : `<${generics}>`;
  return {
    head: `${prefix}(${parameters.map((parameter) => parameter.getText()).join(', ')})`,
    answer,
  };
}
