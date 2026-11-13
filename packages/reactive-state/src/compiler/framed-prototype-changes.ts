import { isIdentifier, isStringLiteral, type Node, type SourceFile } from 'typescript/ast';

const PROTOTYPE_CHANGES = new WeakMap<SourceFile, boolean>();

/** Whether a file may give an array another prototype: it names `__proto__` or `setPrototypeOf`. */
export function prototypeMayChange(file: SourceFile): boolean {
  const known = PROTOTYPE_CHANGES.get(file);
  if (known !== undefined) return known;
  let found = false;
  const pending: Node[] = [file];
  for (let node = pending.pop(); node !== undefined && !found; node = pending.pop()) {
    const name = isIdentifier(node) || isStringLiteral(node) ? node.text : undefined;
    found = name === '__proto__' || name === 'setPrototypeOf';
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  PROTOTYPE_CHANGES.set(file, found);
  return found;
}
