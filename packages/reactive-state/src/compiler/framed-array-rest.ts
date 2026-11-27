import {
  type Expression,
  isArrayBindingPattern,
  isBindingElement,
  isIdentifier,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type TypeNode,
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
  /**
   * A collection's input the compile cannot read, whose declared element type admits an Error
   * (`framedMemberAdmitted`): the element may be one.
   */
  readonly unread?: boolean;
  /**
   * What a native copies its elements from, an input the compile may not read, and the elements'
   * declared type (`framedCopiedUnread`).
   */
  readonly copied?: CopiedElements | undefined;
}

/**
 * The elements a native copies from an input — `Array.from`'s source, an unresolved spread of
 * `Array.of`, `concat`, `with` or `toSpliced` — under their declared type, `undefined` where none
 * is written. Where `follow`, the reading follows the input to what no array reader reads;
 * otherwise, for a result of a callback the compile cannot read, the input is read as such. The
 * first `depth` keys of a reading select the copied element out of arrays it is read from:
 * `groups` of `Array.from(groups[0])` is read on by the element's index first.
 */
interface CopiedElements {
  readonly declared: TypeNode | undefined;
  readonly follow: boolean;
  readonly depth: number;
  /** Whether the input's elements are the copied ones, as `concat`'s array arguments are not. */
  readonly own: boolean;
  /** Whether `declared` is the type of the array the elements are copied into, not of one of them. */
  readonly array?: boolean;
}

/**
 * A flat array-rest binding of a variable copies the remaining elements of its original
 * initializer — none of a parameter, whose default is no source where the call gives an argument.
 */
export function arrayRestView(
  value: Expression,
  index: number | undefined,
): ArrayElementView | undefined {
  if (!isIdentifier(value)) return undefined;
  const declaration = frameDeclarationOf(value);
  if (
    declaration === undefined ||
    !isVariableDeclaration(declaration) ||
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
