import {
  type CallExpression,
  type ClassDeclaration,
  type Expression,
  type FunctionDeclaration,
  type Identifier,
  isBinaryExpression,
  isBindingElement,
  isBlock,
  isCallExpression,
  isCatchClause,
  isClassDeclaration,
  isClassStaticBlockDeclaration,
  isConstructorDeclaration,
  isElementAccessExpression,
  isFunctionDeclaration,
  isIdentifier,
  isNewExpression,
  isObjectBindingPattern,
  isPropertyAccessExpression,
  isSourceFile,
  isSetAccessorDeclaration,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type Node,
  type Statement,
  SyntaxKind,
  type TypeNode,
  type VariableDeclaration,
  isSignatureDeclaration,
} from 'typescript/ast';

import { isAnswering } from './answers.ts';
import { unwrapped } from './bounded.ts';
import { globalPathOf, patternKey } from './code-globals.ts';
import { framedAbortReason } from './framed-abort-reasons.ts';
import { framedArrayResult } from './framed-array-results.ts';
import {
  framedArrayOperand,
  framedArrayString,
  framedArrayText,
  framedArrayWrittenWords,
} from './framed-arrays.ts';
import { frameDeclarationOf, framedInputName, frameTypeOf } from './framed-bindings.ts';
import { observedErrorAt, type ErrorObservation } from './framed-callback-observations.ts';
import { framedClonedObjectData } from './framed-cloned-object-data.ts';
import { framedIteratorResult } from './framed-collection-iterators.ts';
import { framedErrorComparison } from './framed-comparisons.ts';
import {
  framedConstructedData,
  framedConstructionTargets,
  framedSubclassConstructor,
  framedSubclassOwnWords,
} from './framed-constructors.ts';
import { framedDefinedResult } from './framed-defined-values.ts';
import { framedDescriptorSources, framedDescriptorValue } from './framed-descriptors.ts';
import { framedDirectMember } from './framed-direct-members.ts';
import { framedDynamicArrayResult } from './framed-dynamic-array-results.ts';
import { framedErrorCause } from './framed-error-causes.ts';
import { framedErrorMessage } from './framed-error-messages.ts';
import { framedErrorShape } from './framed-error-shape.ts';
import { framedFactoryMemberResult } from './framed-factory-members.ts';
import { framedFinallyResult } from './framed-finally-results.ts';
import { framedJsonMembers } from './framed-json-members.ts';
import { computedBindingContainer } from './framed-keys.ts';
import { framedLiteralObject } from './framed-literal-data.ts';
import { framedMapResult } from './framed-map-results.ts';
import { framedNativeObjectResult } from './framed-native-object-results.ts';
import { framedObjectData } from './framed-object-data.ts';
import { framedPlatformText } from './framed-platform-text.ts';
import { framedPropertyKey } from './framed-property-keys.ts';
import {
  framedNativeErrorCreation,
  framedProxyValues,
  framedPrototypeValues,
  framedThisType,
} from './framed-receivers.ts';
import { framedReflectRead } from './framed-reflect-reads.ts';
import { framedReflectedObjectValues } from './framed-reflected-objects.ts';
import { framedRegExpText } from './framed-regexp-text.ts';
import { framedSourceValues } from './framed-sources.ts';
import { framedObservedNames } from './framed-symbol-keys.ts';
import { framedTemplateText } from './framed-template-text.ts';
import { framedStringText } from './framed-text.ts';
import { framedCallReturns, framedValueShape } from './framed-values.ts';
import {
  framedNamedError,
  framedWrittenErrorInitializer,
  framedWrittenErrorVariable,
} from './framed-written-error-bindings.ts';
import { namesLocalMemberArrayType, namesLocalMemberType } from './local-type-reading.ts';
import { STANDARD_ERRORS } from './local-type-utility-readings.ts';
import { bindingIdentifiers, isBlockScoped } from './scope.ts';

export { namesType, parameterOf } from './framed-type-queries.ts';

/**
 * What of a shared module's code reads what each engine writes otherwise of an error (`settled.ts`):
 * the frames it was made in, and the words of one the code did not make; and what a name is
 * declared of where it is read, or said to be of.
 */

/** The language's errors, and the platform's, whose instances hold the frames they were made in. */
const ERRORS: ReadonlySet<string> = new Set([...STANDARD_ERRORS, 'AggregateError', 'DOMException']);

/**
 * The members of an error that answer of the engine where it runs, of the frames it was made in:
 * its `stack`, which each engine writes otherwise, and Firefox's own, `fileName`, `lineNumber`,
 * `columnNumber`.
 */
const FRAMED: ReadonlySet<string> = new Set(['columnNumber', 'fileName', 'lineNumber', 'stack']);

/** The members of an error that write its words, which the engine that threw it chose: `message`, `toString`. */
const WORDED: ReadonlySet<string> = new Set(['message', 'toString']);

/** The operators that make text of an error beside them: `+`, `+=`. */
const ADDING: ReadonlySet<SyntaxKind> = new Set([SyntaxKind.PlusEqualsToken, SyntaxKind.PlusToken]);

/** A member an error is read of, by its name, and the error — or one a `catch` takes apart. */
interface ErrorRead {
  readonly names: readonly string[] | undefined;
  readonly of: Expression | 'caught' | undefined;
  readonly type?: TypeNode | undefined;
  readonly keys?: readonly string[] | undefined;
  readonly alternatives?: readonly Expression[] | undefined;
}

/** The original observation remains attached while source values and aliases are followed. */
interface ErrorAt {
  readonly keys?: readonly string[] | undefined;
  readonly point?: Node | undefined;
}

/**
 * What of `node` reads what each engine writes otherwise of an error: the frames it was made in
 * (`FRAMED`) — `new Error().stack`, `error['stack']` — of one made there, caught, or given
 * (`isError`); the words of one the code did not make, which the engine that threw it chose —
 * `error.message`, `String(error)`, `${error}` — but of one it makes of words it writes,
 * `new Error('x').message`.
 */
export function framedRead(node: Node): string | undefined {
  const observation = observedErrorAt(node, ERRORS, (value, made, keys) =>
    isError(value, made, new Set(), { keys, point: node }),
  );
  return framedJsonMembers(node, FRAMED, {
    frame: (value, keys) => observation.error(value, true, keys),
    words: observation.words,
    data: sourceErrorData,
  })
    ? 'serializes engine-specific frames or words selected from an error by a JSON property list'
    : framedMemberRead(node, observation);
}

/** Direct members and native text conversions retain the established frame and word checks. */
function framedMemberRead(node: Node, observation: ErrorObservation): string | undefined {
  if (framedPropertyKey(node, observation.words, arrayErrorType))
    return 'uses an error it did not make as a property key, whose words each engine writes otherwise';
  const read = errorRead(node);
  if (read === undefined) {
    return thrownText(node, observation.words)
      ? 'writes an error it did not make as text, whose words each engine writes otherwise'
      : undefined;
  }
  if (
    read.of !== undefined &&
    read.of !== 'caught' &&
    (read.keys?.length ?? 0) === 0 &&
    memberErrorData(read.of, read.names) &&
    (read.alternatives ?? []).every((each) => memberErrorData(each, read.names))
  )
    return undefined;
  const isOf = (made: boolean): boolean => {
    return (
      read.of === 'caught' ||
      namesLocalMemberType(read.type, read.keys ?? [], ERRORS) ||
      (read.alternatives ?? []).some((each) => observation.error(each, made, read.keys)) ||
      (read.of !== undefined && observation.error(read.of, made, read.keys))
    );
  };
  const frame = read.names?.find((name) => FRAMED.has(name));
  if ((frame !== undefined || read.names === undefined) && isOf(true)) {
    return frame === undefined
      ? 'reads a computed member of an error that may expose its engine-specific frames'
      : `reads \`${frame}\` of an error, of the frames it was made in, which each engine writes otherwise`;
  }
  const words = read.names?.find((name) => WORDED.has(name));
  return words !== undefined && isOf(false)
    ? `reads \`${words}\` of an error it did not make, whose words each engine writes otherwise`
    : undefined;
}

/** Source-proven literal members of direct constructions and native mutator results. */
function sourceErrorData(node: Expression, members: readonly string[] | undefined): boolean {
  return framedConstructedData(node, members, ERRORS) || framedObjectData(node, members, ERRORS);
}

/** Source-known ordinary cloned data at an actual member observation. */
function memberErrorData(node: Expression, members: readonly string[] | undefined): boolean {
  return sourceErrorData(node, members) || framedClonedObjectData(node, members, ERRORS);
}

/**
 * The member `node` reads of what, by its name: `error.stack`, `error['message']`, `const { stack }
 * = error`, `catch ({ message })`; none of another node.
 */
function errorRead(node: Node): ErrorRead | undefined {
  const descriptor = framedDescriptorValue(node) ?? framedErrorShape(node, FRAMED);
  if (descriptor !== undefined) return descriptor;
  const reflected = framedReflectRead(node);
  if (reflected !== undefined) return reflected;
  if (isPropertyAccessExpression(node)) {
    return { names: [framedInputName(node)], of: node.expression };
  }
  if (isElementAccessExpression(node)) {
    return { names: framedObservedNames(node), of: node.expression };
  }
  if (!isBindingElement(node) || !isObjectBindingPattern(node.parent)) {
    return undefined;
  }
  const names = framedObservedNames(node);
  const selected = computedBindingContainer(node);
  if (selected === undefined) {
    return undefined;
  }
  const { binding: declaration, keys } = selected;
  if (keys.length === 0 && isCatchClause(declaration.parent)) {
    return { names, of: 'caught' };
  }
  const initializer = declaration.initializer;
  const nativeWords =
    isVariableDeclaration(declaration) &&
    keys.length === 0 &&
    initializer !== undefined &&
    framedWrittenErrorInitializer(initializer, (each, local) =>
      isError(each, local, new Set(), { point: node }),
    );
  return { names, keys, type: nativeWords ? undefined : declaration.type, of: initializer };
}

/**
 * Whether `node` writes as text an error the code did not make (`isError`): `String(error)`,
 * `new String(error)`, a template of it, `error + ''`.
 */
function thrownText(node: Node, textValue: ErrorObservation['words']): boolean {
  if (framedPlatformText(node, textValue, arrayErrorType)) return true;
  if (framedRegExpText(node, textValue, arrayErrorType)) return true;
  if (framedErrorMessage(node, ERRORS, textValue, arrayErrorType)) return true;
  if (framedErrorComparison(node, ERRORS, textValue)) return true;
  const words = { error: textValue, typed: arrayErrorType };
  if (framedArrayText(node, words)) return true;
  if (framedStringText(node, textValue, arrayErrorType)) return true;
  return convertedTextAt(node, words);
}

/** Explicit `String(...)` reads every array; template spans and `+` / `+=` the arrays they can follow. */
function convertedTextAt(
  node: Node,
  words: {
    readonly error: ErrorObservation['words'];
    readonly typed: (value: Expression) => boolean;
  },
): boolean {
  if (
    (isCallExpression(node) || isNewExpression(node)) &&
    globalPathOf(unwrapped(node.expression))?.join('.') === 'String'
  ) {
    return words.error(node.arguments?.[0]) || framedArrayString(node.arguments?.[0], words, node);
  }
  const converts = (value: Expression | undefined): boolean =>
    words.error(value) || framedArrayOperand(value, words, node);
  if (framedTemplateText(node, converts)) {
    return true;
  }
  return (
    isBinaryExpression(node) &&
    ADDING.has(node.operatorToken.kind) &&
    (converts(node.left) || converts(node.right))
  );
}

/** An explicitly written array or tuple type whose elements include an engine error. */
function arrayErrorType(node: Expression): boolean {
  const selected = frameTypeOf(node);
  return (
    selected !== undefined &&
    !framedArrayWrittenWords(node, (each) => framedNativeErrorCreation(each, ERRORS, false)) &&
    namesLocalMemberArrayType(selected.type, selected.keys, ERRORS, { nested: true })
  );
}

/**
 * Whether `node` is an error: one of the language's or the platform's made there, `new Error()`,
 * `TypeError('x')`, where `made` counts those; one a `catch` takes; a parameter or a variable said
 * to be one, `(error: Error)`, through a local type alias too; or what a variable around it is
 * declared of, in turn.
 */
function isError(node: Expression, made: boolean, seen: Set<Node>, at: ErrorAt = {}): boolean {
  const { keys = [], point } = at;
  if (seen.has(node)) return false;
  seen.add(node);
  const { value, assertions } = framedValueShape(node);
  if (framedLiteralObject(value)) return false;
  if (keys.length === 0 && framedNativeErrorCreation(value, ERRORS, made)) return made;
  const targets = keys.length === 0 ? framedConstructionTargets(value) : undefined;
  if (targets?.some((each) => framedSubclassConstructor(each, ERRORS)) === true)
    return made || targets.some((each) => !framedSubclassOwnWords(each, ERRORS));
  if (keys.length === 0) {
    const result = selectedResultError(value, made, seen, point);
    if (result !== undefined) return result;
  }

  return (
    sourceError(value, made, seen, { keys, point }) ??
    typedOrNamedError({ assertions, value }, made, seen, { keys, point })
  );
}

/** Written error assertions, annotations, and lexical bindings after direct sources are checked. */
function typedOrNamedError(
  shape: ReturnType<typeof framedValueShape>,
  made: boolean,
  seen: Set<Node>,
  at: { readonly keys: readonly string[]; readonly point?: Node | undefined },
): boolean {
  const { assertions, value } = shape;
  const { keys, point } = at;
  if (
    framedWrittenErrorVariable(value, { keys, made }, (each, local) =>
      isError(each, local, new Set(seen), { point }),
    )
  )
    return false;
  if (assertions.some((each) => namesLocalMemberType(each.type, [...each.keys, ...keys], ERRORS)))
    return true;
  const selected = frameTypeOf(value) ?? framedThisType(value);
  if (
    selected !== undefined &&
    namesLocalMemberType(selected.type, [...selected.keys, ...keys], ERRORS)
  )
    return true;
  return (
    keys.length === 0 &&
    isIdentifier(value) &&
    framedNamedError(
      value,
      { errors: ERRORS, made },
      {
        branch: (each, local, path) => isError(each, local, new Set(seen), { keys: path, point }),
        chain: (each, local, path) => isError(each, local, seen, { keys: path, point }),
      },
    )
  );
}

/** Native selections and written factory results retain the selected error and its own words. */
function selectedResultError(
  call: Expression,
  made: boolean,
  seen: Set<Node>,
  point?: Node,
): boolean | undefined {
  const error = (each: Expression, local: boolean, keys: readonly string[] = []) =>
    isError(each, local, new Set(seen), { keys, point });
  const indexed = framedDynamicArrayResult(call, made, ERRORS, error);
  if (indexed !== undefined) return indexed;
  return isCallExpression(call)
    ? (framedArrayResult(call, made, ERRORS, error) ??
        framedMapResult(call, made, ERRORS, error) ??
        factoryError(call, made, seen, point))
    : undefined;
}

/** Possible source receivers retain error observations and locally constructed words. */
function sourceError(
  value: Expression,
  made: boolean,
  seen: Set<Node>,
  at: ErrorAt,
): boolean | undefined {
  const { keys = [], point } = at;
  const aborted = framedAbortReason(value, { made, keys }, (each, local, path) =>
    isError(each, local, new Set(seen), { keys: path, point }),
  );
  if (aborted !== undefined) return aborted;
  const fulfilled = framedFinallyResult(value, made, keys, (each, local, path) =>
    isError(each, local, new Set(seen), { keys: path, point }),
  );
  if (fulfilled !== undefined) return fulfilled;
  const native = framedNativeObjectResult(value, { made, keys }, ERRORS, (each, local, path) =>
    isError(each, local, new Set(seen), { keys: path, point }),
  );
  if (native !== undefined) return native;
  const iterated = framedIteratorResult(value, { made, keys }, (each, local, path) =>
    isError(each, local, new Set(seen), { keys: path, point }),
  );
  if (iterated !== undefined) return iterated;
  const returned = framedFactoryMemberResult(value, { made, keys }, (each, local) =>
    isError(each, local, new Set(seen), { point }),
  );
  if (returned !== undefined) return returned;
  const cause = framedErrorCause(value, { made, keys }, ERRORS, (each, local, path) =>
    isError(each, local, new Set(seen), { keys: path, point }),
  );
  if (cause !== undefined) return cause;
  const defined = framedDefinedResult(value, keys, (each, path) =>
    isError(each, made, new Set(seen), { keys: path, point }),
  );
  if (defined !== undefined) return defined;
  if (
    framedDirectMember(
      value,
      keys,
      (each, path) => isError(each, made, new Set(seen), { keys: path, point }),
      point,
    )
  )
    return true;
  const results =
    framedDescriptorSources(value) ??
    framedSourceValues(value) ??
    framedReflectedObjectValues(value) ??
    framedProxyValues(value, point) ??
    framedPrototypeValues(value);
  if (results === undefined) return undefined;
  if (results.some((each) => isError(each, made, new Set(seen), { keys, point }))) return true;
  if (
    !made &&
    keys.length === 0 &&
    results.every((each) => isError(each, true, new Set(seen), { point }))
  )
    return false;
  return undefined;
}

/** Local result bodies retain their own constructed words, even behind an outer assertion. */
function factoryError(
  call: CallExpression,
  made: boolean,
  seen: Set<Node>,
  point?: Node,
): boolean | undefined {
  const results = framedCallReturns(call, frameDeclarationOf);
  if (results === undefined) return undefined;
  if (results.some((each) => isError(each, made, new Set(seen), { point }))) return true;
  if (
    !made &&
    results.length > 0 &&
    results.every((each) => isError(each, true, new Set(seen), { point }))
  )
    return false;
  return undefined;
}

/** What declares a name in a block or at a module's top level: a variable, a function, a class. */
export type Declared = ClassDeclaration | FunctionDeclaration | VariableDeclaration;

/**
 * What `name` is declared of where it is read: the initializer of the variable the nearest block
 * around it declares of the name, or the module's top level (`declarationOf`) — none of a function
 * or a class declared there, nor past a function whose parameter it is.
 */
export function initializerOf(name: Identifier): Expression | undefined {
  const declared = declarationOf(name);
  return declared !== undefined && isVariableDeclaration(declared)
    ? declared.initializer
    : undefined;
}

/**
 * What declares `name` where it is read: the variable, the function or the class the nearest block
 * around it declares of the name, or the module's top level — none past a function whose parameter
 * it is, which each call is given anew.
 */
export function declarationOf(name: Identifier): Declared | undefined {
  for (let at: Node = name.parent; ; at = at.parent) {
    if (bindsParameter(at, name.text)) {
      return undefined;
    }
    const declaration =
      isBlock(at) || isSourceFile(at) ? declarationIn(at.statements, name.text) : undefined;
    if (declaration !== undefined || isSourceFile(at)) {
      return declaration;
    }
  }
}

/**
 * What `name` is taken apart of where it is read, by the key a pattern of a variable the nearest
 * block around it declares takes it by — `writable` of `new TransformStream()` of `const { writable }
 * = new TransformStream()` — at the pattern's top; none of a name declared otherwise, nor past a
 * function whose parameter it is.
 */
export function takenApartOf(
  name: Identifier,
): { readonly key: string; readonly of: Expression } | undefined {
  for (let at: Node = name.parent; ; at = at.parent) {
    if (bindsParameter(at, name.text)) {
      return undefined;
    }
    const statements = isBlock(at) || isSourceFile(at) ? at.statements : [];
    for (const statement of statements) {
      const taken = isVariableStatement(statement)
        ? takenIn(statement.declarationList.declarations, name.text)
        : undefined;
      if (taken !== undefined) {
        return taken;
      }
    }
    if (isSourceFile(at)) {
      return undefined;
    }
  }
}

/** The key and the value `declarations` take the name `name` apart by and of, at a pattern's top. */
function takenIn(
  declarations: readonly VariableDeclaration[],
  name: string,
): { readonly key: string; readonly of: Expression } | undefined {
  for (const declaration of declarations) {
    const pattern = declaration.name;
    const element =
      declaration.initializer !== undefined && isObjectBindingPattern(pattern)
        ? pattern.elements.find(
            (each) => each.name !== undefined && isIdentifier(each.name) && each.name.text === name,
          )
        : undefined;
    const key = element === undefined ? undefined : patternKey(element);
    if (key !== undefined && declaration.initializer !== undefined) {
      return { key, of: declaration.initializer };
    }
  }
  return undefined;
}

/** What of `statements` declares `name`, as they are written: a variable, a function, a class. */
function declarationIn(statements: readonly Statement[], name: string): Declared | undefined {
  for (const statement of statements) {
    if (
      (isFunctionDeclaration(statement) || isClassDeclaration(statement)) &&
      statement.name?.text === name
    ) {
      return statement;
    }
    const declaration = isVariableStatement(statement)
      ? statement.declarationList.declarations.find(
          (each) => isIdentifier(each.name) && each.name.text === name && !repeatsParameter(each),
        )
      : undefined;
    if (declaration !== undefined) {
      return declaration;
    }
  }
  return undefined;
}

/** An empty `var` in a parameter's own function leaves that parameter's value intact. */
function repeatsParameter(declaration: VariableDeclaration): boolean {
  if (
    declaration.initializer !== undefined ||
    !isIdentifier(declaration.name) ||
    !isVariableDeclarationList(declaration.parent) ||
    isBlockScoped(declaration.parent)
  ) {
    return false;
  }
  for (let at: Node = declaration.parent; !isSourceFile(at); at = at.parent) {
    if (isClassStaticBlockDeclaration(at)) {
      return false;
    }
    if (isAnswering(at) || isConstructorDeclaration(at) || isSetAccessorDeclaration(at)) {
      return bindsParameter(at, declaration.name.text);
    }
  }
  return false;
}

/** Whether `node`, where it is a function, binds `name` as one of its parameters. */
function bindsParameter(node: Node, name: string): boolean {
  // A node of no function holds no parameters, though it may hold a field of the name.
  const parameters = isSignatureDeclaration(node) ? node.parameters : [];
  return parameters.some((parameter) =>
    bindingIdentifiers(parameter.name).some((each) => each.text === name),
  );
}
