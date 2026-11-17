import {
  type Expression,
  type Identifier,
  isCatchClause,
  isClassStaticBlockDeclaration,
  isConstructorDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isModuleDeclaration,
  isParameterDeclaration,
  isSetAccessorDeclaration,
  isSourceFile,
  isVariableDeclaration,
  isVariableDeclarationList,
  type Node,
  type VariableDeclaration,
} from 'typescript/ast';

import { type Answering, isAnswering } from './answers.ts';
import { framedArrayCallbackError } from './framed-array-callback-errors.ts';
import { frameBindingOf, frameDeclarationOf } from './framed-bindings.ts';
import { framedPatternDefaults } from './framed-pattern-defaults.ts';
import { framedAssignedSources } from './framed-writes.ts';
import {
  provenWrittenErrorInitializer,
  type ResolvedErrorVariable,
  type WrittenErrorCheck,
} from './framed-written-error-initializers.ts';
import {
  enclosingValueScope,
  lexicalErrorAlias,
  nonEscapingErrorRead,
  returnedFromScope,
} from './framed-written-error-uses.ts';
import { namesLocalMemberType } from './local-type-reading.ts';
import { bindingIdentifiers, freeReads, isBlockScoped, isTypeOnly, readsBinding } from './scope.ts';

/**
 * Unmutated local variable bindings whose initializer is universally proven to construct an error
 * with source-written words keep that word proof even when annotated `: Error`, while `.stack`
 * (`made === true`), catch bindings, parameters, reassignments, alias writes, and escaping
 * references remain flagged.
 */

interface SourceVariableReads {
  readonly reads: ReadonlyMap<VariableDeclaration, readonly Identifier[]>;
  readonly varCounts: ReadonlyMap<Node, ReadonlyMap<string, number>>;
}

const CAUGHT_READS = new WeakMap<Node, ReadonlySet<Identifier>>();
const VARIABLE_READS = new WeakMap<Node, SourceVariableReads>();

/** Whether `name` is what an enclosing `catch` clause binds. */
function isCaughtBinding(name: Identifier): boolean {
  for (let at: Node = name.parent; !isSourceFile(at); at = at.parent) {
    if (!isCatchClause(at) || at.variableDeclaration === undefined) continue;
    const caught = bindingIdentifiers(at.variableDeclaration.name);
    if (caught.every((each) => each.text !== name.text)) continue;
    let reads = CAUGHT_READS.get(at.block);
    if (reads === undefined) {
      reads = new Set(freeReads(at.block));
      CAUGHT_READS.set(at.block, reads);
    }
    return reads.has(name);
  }
  return false;
}

/** Whether `initializer` constructs a local error whose words are written by the source. */
export function framedWrittenErrorInitializer(
  initializer: Expression,
  check: WrittenErrorCheck,
): boolean {
  return provenWrittenErrorInitializer(initializer, {
    check,
    resolveVariable: resolveUnmutatedVariable,
  });
}

/** Whether `value` reads an unmutated local variable initialized to source-written error words. */
export function framedWrittenErrorVariable(
  value: Expression,
  selection: { readonly keys: readonly string[]; readonly made: boolean },
  check: WrittenErrorCheck,
): boolean {
  if (selection.made || selection.keys.length > 0 || !isIdentifier(value)) return false;
  const resolved = resolveUnmutatedVariable(value, undefined);
  return resolved !== undefined && framedWrittenErrorInitializer(resolved.initializer, check);
}

/** Resolves a lexical error binding after explicit receiver syntax and written-word proofs. */
export function framedNamedError(
  value: Identifier,
  context: { readonly errors: ReadonlySet<string>; readonly made: boolean },
  check: {
    readonly branch: (value: Expression, made: boolean, keys?: readonly string[]) => boolean;
    readonly chain: (value: Expression, made: boolean, keys?: readonly string[]) => boolean;
  },
): boolean {
  if (isCaughtBinding(value)) return true;
  const declared = frameDeclarationOf(value);
  if (declared === undefined) return false;
  if (!isVariableDeclaration(declared) && !isParameterDeclaration(declared)) return false;
  const defaults = framedPatternDefaults(value, declared);
  const keys = defaults === undefined ? [] : (frameBindingOf(value)?.keys ?? []);
  const { errors, made } = context;
  return (
    framedArrayCallbackError(value, made, errors, check.branch) ||
    namesLocalMemberType(declared.type, keys, errors) ||
    framedAssignedSources(value).some((each) => check.branch(each.value, made, each.keys)) ||
    defaults?.some((each) => check.branch(each, made)) === true ||
    (declared.initializer !== undefined && check.chain(declared.initializer, made, keys))
  );
}

/** Resolves an identifier read to an unmutated lexical `VariableDeclaration` and its initializer. */
function resolveUnmutatedVariable(
  read: Identifier,
  returnScope: Answering | undefined,
): ResolvedErrorVariable | undefined {
  if (isCaughtBinding(read)) return undefined;
  const declared = frameDeclarationOf(read);
  if (
    declared === undefined ||
    !isVariableDeclaration(declared) ||
    !isIdentifier(declared.name) ||
    isCatchClause(declared.parent) ||
    declared.initializer === undefined
  ) {
    return undefined;
  }
  const allowedReturn =
    returnScope !== undefined && enclosingValueScope(declared) === returnScope
      ? returnScope
      : undefined;
  if (!unmutatedVariableBinding(declared, read, allowedReturn)) return undefined;
  return { initializer: declared.initializer, nextReturnScope: allowedReturn };
}

/** Follows whole lexical aliases and requires every reference to stay read-only and non-escaping. */
function unmutatedVariableBinding(
  declared: VariableDeclaration,
  read: Identifier,
  allowedReturn: Answering | undefined,
): boolean {
  if (!isVariableDeclarationList(declared.parent) || !isIdentifier(declared.name)) return false;
  const blockScoped = isBlockScoped(declared.parent);
  if (!blockScoped && declared.end > read.pos) return false;
  const indexed = sourceVariableReads(declared.getSourceFile());
  if (!blockScoped) {
    const scopeCounts = indexed.varCounts.get(hoistedVarScope(declared));
    if ((scopeCounts?.get(declared.name.text) ?? 0) > 1) return false;
  }
  const bindings: VariableDeclaration[] = [declared];
  const seen = new Set<VariableDeclaration>([declared]);
  for (const current of bindings) {
    const references = indexed.reads.get(current) ?? [];
    if (!safeBindingReferences(references, bindings, seen, allowedReturn)) return false;
  }
  return true;
}

/** Indexes variable binding reads and per-scope hoisted `var` counts once per source file. */
function sourceVariableReads(sourceFile: Node): SourceVariableReads {
  const cached = VARIABLE_READS.get(sourceFile);
  if (cached !== undefined) return cached;
  const reads = new Map<VariableDeclaration, Identifier[]>();
  const varCounts = new Map<Node, Map<string, number>>();
  const pending: Node[] = [sourceFile];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isTypeOnly(node)) continue;
    recordHoistedDeclaration(node, varCounts);
    recordVariableRead(node, reads);
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  const indexed: SourceVariableReads = { reads, varCounts };
  VARIABLE_READS.set(sourceFile, indexed);
  return indexed;
}

/** Counts non-block-scoped `var` bindings per execution scope to detect duplicate hoisted names. */
function recordHoistedDeclaration(node: Node, varCounts: Map<Node, Map<string, number>>): void {
  if (!isVariableDeclaration(node) || !isVariableDeclarationList(node.parent)) return;
  if (isBlockScoped(node.parent)) return;
  const scope = hoistedVarScope(node);
  let counts = varCounts.get(scope);
  if (counts === undefined) {
    counts = new Map();
    varCounts.set(scope, counts);
  }
  for (const bound of bindingIdentifiers(node.name)) {
    counts.set(bound.text, (counts.get(bound.text) ?? 0) + 1);
  }
}

/** Resolves the callable, accessor, constructor, static-block, namespace, or file hoisting scope. */
function hoistedVarScope(node: Node): Node {
  for (let at: Node = node.parent; !isSourceFile(at); at = at.parent) {
    if (
      isAnswering(at) ||
      isConstructorDeclaration(at) ||
      isGetAccessorDeclaration(at) ||
      isSetAccessorDeclaration(at) ||
      isClassStaticBlockDeclaration(at) ||
      isModuleDeclaration(at)
    ) {
      return at;
    }
  }
  return node.getSourceFile();
}

/** Groups non-declaration identifier reads under their resolved `VariableDeclaration`. */
function recordVariableRead(node: Node, reads: Map<VariableDeclaration, Identifier[]>): void {
  if (!isIdentifier(node) || !readsBinding(node)) return;
  const declared = frameDeclarationOf(node);
  if (declared === undefined || !isVariableDeclaration(declared) || node === declared.name) return;
  const existing = reads.get(declared);
  if (existing === undefined) reads.set(declared, [node]);
  else existing.push(node);
}

/** Queues whole lexical aliases and verifies every other reference is a pure read or factory return. */
function safeBindingReferences(
  references: readonly Identifier[],
  bindings: VariableDeclaration[],
  seen: Set<VariableDeclaration>,
  allowedReturn: Answering | undefined,
): boolean {
  for (const reference of references) {
    const alias = lexicalErrorAlias(reference);
    if (alias !== undefined) {
      if (!seen.has(alias)) {
        seen.add(alias);
        bindings.push(alias);
      }
      continue;
    }
    const allowedFactoryReturn =
      allowedReturn !== undefined && returnedFromScope(reference, allowedReturn);
    if (!allowedFactoryReturn && !nonEscapingErrorRead(reference)) return false;
  }
  return true;
}
