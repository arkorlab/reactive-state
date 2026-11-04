import {
  type Expression,
  isArrayBindingPattern,
  isBindingElement,
  isIdentifier,
  isParameterDeclaration,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
} from 'typescript/ast';

import { frameDeclarationOf, type FrameBinding } from './framed-bindings.ts';

/** Source array views retain copy offsets and the time their element slots were copied. */
export interface ArrayElementView {
  readonly value: Expression;
  readonly index: number | undefined;
  readonly start?: number | undefined;
  readonly end?: number | undefined;
  readonly capture?: Node;
  readonly element?: boolean;
  readonly keys?: readonly string[] | undefined;
  /** A native mapper rest array keeps its own layer around the remaining callback arguments. */
  readonly packedRest?: {
    readonly receiver: Expression;
    readonly index: number | undefined;
    readonly offset: number;
  };
  /** Only the written annotation of the value is read, none of its initializer or writes. */
  readonly typeOnly?: boolean;
}

/** A flat array-rest binding copies the remaining elements of its original initializer. */
export function arrayRestView(
  value: Expression,
  index: number | undefined,
): ArrayElementView | undefined {
  if (!isIdentifier(value)) return undefined;
  const declaration = frameDeclarationOf(value);
  if (
    declaration === undefined ||
    (!isVariableDeclaration(declaration) && !isParameterDeclaration(declaration)) ||
    !isArrayBindingPattern(declaration.name) ||
    declaration.initializer === undefined
  )
    return undefined;
  const offset = declaration.name.elements.findIndex((each) => {
    return (
      isBindingElement(each) &&
      each.dotDotDotToken !== undefined &&
      each.name !== undefined &&
      isIdentifier(each.name) &&
      each.name.text === value.text
    );
  });
  if (offset === -1) return undefined;
  return {
    value: declaration.initializer,
    index: index === undefined || index < 0 ? index : index + offset,
    start: offset,
    capture: declaration.initializer,
  };
}

/** A directly named constant rest array has its own methods, apart from the copied source. */
export function arrayRestBinding(value: Expression): FrameBinding | undefined {
  if (!isIdentifier(value) || arrayRestView(value, undefined) === undefined) return undefined;
  const binding = frameDeclarationOf(value);
  if (binding === undefined || !isVariableDeclaration(binding)) return undefined;
  const list = binding.parent;
  return isVariableDeclarationList(list) && /^const\b/u.test(list.getText(binding.getSourceFile()))
    ? binding
    : undefined;
}
