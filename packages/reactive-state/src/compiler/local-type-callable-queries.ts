import {
  factory,
  isArrowFunction,
  isBlock,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isModuleBlock,
  isParameterDeclaration,
  isSourceFile,
  isTypeQueryNode,
  isVariableDeclaration,
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type FunctionTypeNode,
  type Node,
  SyntaxKind,
} from 'typescript/ast';

import { frameDeclarationOf, type FrameDeclaration } from './framed-bindings.ts';
import type { TypeReading } from './local-type-environment.ts';
import { acceptsQueryArguments, queryArgumentReadings } from './local-type-query-arguments.ts';

/** Written callable annotations selected through local value type queries. */

const CALLABLES = new WeakMap<Node, FunctionTypeNode>();

/** The last written overload or explicit local callable type, with lexical shadows left in place. */
export function callableQueryReading(at: TypeReading): TypeReading | undefined {
  if (!isTypeQueryNode(at.type) || !isIdentifier(at.type.exprName)) return undefined;
  let name = at.type.exprName;
  const seen = new Set<Node>();
  while (!seen.has(name)) {
    seen.add(name);
    const declared = frameDeclarationOf(name);
    if (declared === undefined) return undefined;
    const direct = declarationReading(at, declared);
    if (direct !== undefined) return direct;
    const value = isVariableDeclaration(declared) ? declared.initializer : undefined;
    if (value === undefined || !isIdentifier(value)) return undefined;
    name = value;
  }
  return undefined;
}

/** A callable signature reuses original parameter/result nodes and a stable synthetic container. */
function signatureReading(
  at: TypeReading,
  declaration: FunctionDeclaration | FunctionExpression | ArrowFunction,
): TypeReading {
  let type = CALLABLES.get(declaration);
  if (type === undefined) {
    type = factory.createFunctionTypeNode(
      declaration.typeParameters,
      declaration.parameters,
      declaration.type ?? factory.createKeywordTypeNode(SyntaxKind.UnknownKeyword),
    );
    CALLABLES.set(declaration, type);
  }
  return { ...at, type };
}

/** An overload set uses its final declaration signature rather than the implementation signature. */
function lastOverload(declared: FunctionDeclaration, at: TypeReading): FunctionDeclaration {
  const owner = declared.parent;
  if (!isSourceFile(owner) && !isBlock(owner) && !isModuleBlock(owner)) return declared;
  let selected = declared;
  let applicable = declared;
  const count = isTypeQueryNode(at.type) ? at.type.typeArguments?.length : undefined;
  for (const statement of owner.statements) {
    if (
      isFunctionDeclaration(statement) &&
      statement.name?.text === declared.name?.text &&
      statement.body === undefined
    ) {
      selected = statement;
      if (count !== undefined && acceptsQueryArguments(statement, count)) applicable = statement;
    }
  }
  if (count === undefined) return selected;
  const reading = signatureReading(at, applicable);
  const [applied] = queryArgumentReadings(at, [reading], (value) => [value]);
  return applied?.type === reading.type ? selected : applicable;
}

/** Explicit annotations and written function signatures supply types without evaluating their bodies. */
function declarationReading(at: TypeReading, declared: FrameDeclaration): TypeReading | undefined {
  if (isFunctionDeclaration(declared)) return signatureReading(at, lastOverload(declared, at));
  if (!isVariableDeclaration(declared) && !isParameterDeclaration(declared)) return undefined;
  if (declared.type !== undefined) return { ...at, type: declared.type };
  const value = isVariableDeclaration(declared) ? declared.initializer : undefined;
  return value !== undefined && (isFunctionExpression(value) || isArrowFunction(value))
    ? signatureReading(at, value)
    : undefined;
}
