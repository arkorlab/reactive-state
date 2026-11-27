import {
  type Block,
  type Expression,
  type Identifier,
  isArrayLiteralExpression,
  isArrowFunction,
  isBlock,
  isClassDeclaration,
  isComputedPropertyName,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isSourceFile,
  isVariableStatement,
  NodeFlags,
  type SourceFile,
  type Statement,
  SyntaxKind,
  type VariableStatement,
} from 'typescript/ast';

import { type Answering, isAnswering } from './answers.ts';
import { globalOf, importedValues, unwrapped } from './bounded.ts';
import { bindingIdentifiers } from './scope.ts';

/** Initializations that may be omitted without skipping calls, coercions or property reads. */
const INERT: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.BigIntLiteral,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NullKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.OmittedExpression,
  SyntaxKind.StringLiteral,
  SyntaxKind.TrueKeyword,
]);

/**
 * The globals a read of which runs nothing and cannot throw: non-writable, non-configurable
 * properties of the global object — a data property has no getter to run, and none can be deleted or
 * absent — so reading one is as inert as a literal. Any other global is not: a property of the
 * global object may be an accessor, as `Object.defineProperty(globalThis, 'g', { get() { … } })`
 * makes one, and may be absent where the code runs (`window` on a server), which throws.
 */
const INERT_GLOBALS: ReadonlySet<string> = new Set(['Infinity', 'NaN', 'undefined']);

/** Whether a read of the name is one the code shows initialised where a statement runs. */
type Shown = (name: string) => boolean;

/**
 * Whether leaving a statement out skips only values whose construction runs no application code.
 * A `using` or an `await using` is more than its value: it reads the resource's disposal method and
 * registers a cleanup its scope runs, which only its whole behavior could show inert, so it stays.
 * So does a read of a name the code does not show initialised (`shownAt`): reading one runs a
 * global's getter, and throws where a `let`, a `const` or a class is read before its declaration,
 * or where nothing declares it. A name the code shows initialised is read without running or
 * throwing anything, alone or within a container, and is left out with the rest; so is a read of
 * `undefined`, `NaN` or `Infinity` where no declaration of the name is in the file (`INERT_GLOBALS`).
 */
export function canOmit(statement: VariableStatement): boolean {
  // eslint-disable-next-line no-bitwise -- TypeScript says `using` and `await using` in this flag.
  if ((statement.declarationList.flags & NodeFlags.Using) !== 0) {
    return false;
  }
  const shown = shownAt(statement);
  // What the declarations of the statement before the one read declare, initialised in their turn.
  const own = new Set<string>();
  for (const { initializer, name } of statement.declarationList.declarations) {
    if (
      initializer === undefined ||
      !isIdentifier(name) ||
      !inertValue(initializer, (read) => own.has(read) || shown(read))
    ) {
      return false;
    }
    own.add(name.text);
  }
  return true;
}

/**
 * Which names the code shows initialised where `statement` runs, a statement of a function's body:
 * the function's parameters and what their patterns bind, what the statements of the body before
 * it declare, and — in a function the module declares at its top level, around which no scope
 * stands — what the module imports as a value, which is initialised once the modules are
 * evaluated, as they are before a component renders. A name the body declares in `statement` or
 * after it is none, whatever else gives the name: a `let`, a `const` or a class read before its
 * declaration throws. Of a statement that stands elsewhere — in a block, at a module's top level —
 * and of every other name — a global, whose getter may run, a name nothing declares, a constant of
 * the module, which a call made as the module loads may read before its declaration — the code
 * shows nothing. What a body declares is read once of the body (`namesOf`), so each statement of
 * it is answered by looking a name up.
 */
function shownAt(statement: VariableStatement): Shown {
  const body = statement.parent;
  const fn = body.parent;
  if (!isBlock(body) || !isAnswering(fn) || fn.body !== body) {
    return () => false;
  }
  const names = namesOf(fn, body);
  const at = statement.pos;
  return (name) => {
    const last = names.declared.get(name);
    return last === undefined ? names.given.has(name) : last < at;
  };
}

/** What a function's body shows of the names read in it. */
interface BodyNames {
  /** Each name a statement of the body declares, by where the last statement that declares it starts. */
  readonly declared: ReadonlyMap<string, number>;
  /** What the body is given before it runs: the parameters' names, and the module's value imports. */
  readonly given: ReadonlySet<string>;
}

/** What each function's body shows of its names, read once. */
const BODIES = new WeakMap<Block, BodyNames>();

/** What each module imports as a value, read once. */
const IMPORTED = new WeakMap<SourceFile, ReadonlySet<string>>();

/** What the body of `fn` shows of its names (`BodyNames`), read once of each body. */
function namesOf(fn: Answering, body: Block): BodyNames {
  const known = BODIES.get(body);
  if (known !== undefined) {
    return known;
  }
  const given = new Set(isSourceFile(fn.parent) ? importedBy(fn.parent) : []);
  for (const parameter of fn.parameters) {
    for (const name of bindingIdentifiers(parameter.name)) {
      given.add(name.text);
    }
  }
  const declared = new Map<string, number>();
  for (const each of body.statements) {
    for (const name of declaredBy(each)) {
      declared.set(name, each.pos);
    }
  }
  const names = { declared, given };
  BODIES.set(body, names);
  return names;
}

/** What `file` imports as a value (`importedValues`), read once of each file. */
function importedBy(file: SourceFile): ReadonlySet<string> {
  let imported = IMPORTED.get(file);
  if (imported === undefined) {
    imported = new Set(importedValues(file));
    IMPORTED.set(file, imported);
  }
  return imported;
}

/** The names a statement declares where it stands: a variable's, a pattern's, a function's, a class's. */
function declaredBy(statement: Statement): readonly string[] {
  if (isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      bindingIdentifiers(declaration.name).map((name) => name.text),
    );
  }
  return (isFunctionDeclaration(statement) || isClassDeclaration(statement)) &&
    statement.name !== undefined
    ? [statement.name.text]
    : [];
}

/**
 * A literal, function or data container whose evaluation does not call or coerce another value,
 * and reads no name but one the code shows initialised (`shown`).
 */
function inertValue(expression: Expression, shown: Shown): boolean {
  const pending = [expression];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const children = inertChildren(unwrapped(next), shown);
    if (children === undefined) {
      return false;
    }
    pending.push(...children);
  }
  return true;
}

/**
 * Whether `name` reads one of the inert globals (`INERT_GLOBALS`): the name is one of them and no
 * declaration in its file gives it, nor an import of a value (`globalOf`, which reads each file once).
 * Where one does — a parameter, a local, a module's declaration, an import — the name read is that
 * one, which the rules of `shownAt` answer, and nothing here: a local read before its declaration
 * throws, though the global of its name would not.
 */
function readsInertGlobal(name: Identifier): boolean {
  return INERT_GLOBALS.has(name.text) && globalOf(name) === name.text;
}

/** The values an inert expression evaluates; none where another evaluation must be preserved. */
function inertChildren(value: Expression, shown: Shown): readonly Expression[] | undefined {
  if (INERT.has(value.kind) || isArrowFunction(value) || isFunctionExpression(value)) {
    return [];
  }
  if (isIdentifier(value)) {
    return shown(value.text) || readsInertGlobal(value) ? [] : undefined;
  }
  if (isArrayLiteralExpression(value)) {
    return value.elements;
  }
  if (!isObjectLiteralExpression(value)) {
    return undefined;
  }
  const values: Expression[] = [];
  for (const property of value.properties) {
    if (!isPropertyAssignment(property) || isComputedPropertyName(property.name)) {
      return undefined;
    }
    values.push(property.initializer);
  }
  return values;
}
