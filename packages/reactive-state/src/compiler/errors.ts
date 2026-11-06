import type { Node, SourceFile } from 'typescript/ast';

/** A zero-based line and column, as TypeScript reports a position. */
interface Position {
  readonly line: number;
  readonly character: number;
}

export interface ReactiveCompileErrorOptions extends ErrorOptions {
  readonly fileName: string;
  readonly position: Position;
}

/**
 * Why a `.reactive.tsx` component was refused, at the place in it that was refused. The compiler
 * refuses whatever it cannot carry over whole — an authorization it would have to leave out, a
 * closure it cannot register, a server value that would reach the browser — rather than compile
 * around it. The message leads with `file:line:column`, one-based.
 */
export class ReactiveCompileError extends Error {
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
  readonly reason: string;

  constructor(reason: string, options: ReactiveCompileErrorOptions) {
    const line = options.position.line + 1;
    const column = options.position.character + 1;
    super(`${options.fileName}:${String(line)}:${String(column)}: ${reason}`, options);
    this.name = 'ReactiveCompileError';
    this.fileName = options.fileName;
    this.line = line;
    this.column = column;
    this.reason = reason;
  }
}

/** Refuses the component at `node`, or at its start when no node is given. */
export type Fail = (reason: string, node?: Node) => never;

export function failIn(sourceFile: SourceFile, fileName: string): Fail {
  return (reason, node) => {
    const position = sourceFile.getLineAndCharacterOfPosition(
      node === undefined ? 0 : node.getStart(sourceFile),
    );
    throw new ReactiveCompileError(reason, { fileName, position });
  };
}
