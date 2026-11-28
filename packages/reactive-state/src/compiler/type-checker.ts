/**
 * TypeScript's checker, for the questions the compile asks of a declared type. The compile parses
 * each module alone (`parseModule`), and a node of such a parse belongs to no program: TypeScript
 * names a node by its file and its index, so one handed to a program's checker would be read as
 * another node of the program's file. A compile's `TypeSession` therefore makes a program of every
 * module text it has read, on the first question, through a snapshot whose file system holds those
 * texts over the disk's, with the options of the nearest `tsconfig.json` as TypeScript parses them;
 * a node asked about is found again in the program's own source file, by its position and kind, and
 * only the program's nodes reach the checker. The program is made again when a module read since is
 * asked about, and every snapshot is disposed of with the session.
 *
 * What the checker answers also depends on which file it takes for each import, which no text of a
 * file read says: a file added that TypeScript prefers to the one it took, or one at an import it
 * found none at, changes the answer with every text read unchanged. The session therefore hands
 * each import of each application file a program holds — a type-only one too, which the compile
 * itself never resolves as a module — to the resolver its compile reads modules with, which records
 * the file chosen, or that none was, beside the compile's own choices.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { isStringLiteralLikeNode, type Node, type SourceFile } from 'typescript/ast';
import {
  type API,
  type Checker,
  type Program,
  type SnapshotOperation,
  SymbolFlags,
  type Type,
} from 'typescript/sync';

import { aliasesOf, nearestTsconfig } from '../authority/aliases.ts';

/** The global types the questions read, by their ids in a program's checker. */
export interface CheckerGlobals {
  /** The global `Error` interface. */
  readonly error: Type;
  /** The language's and the platform's Error types, each value of which is an Error. */
  readonly errorFamily: ReadonlySet<number>;
  /** The global collection types of each kind, whose type arguments say what it holds. */
  readonly natives: Readonly<Record<'Map' | 'Set', ReadonlySet<number>>>;
}

/** A node asked about, as the program's checker reads it. */
export interface CheckedNode {
  readonly checker: Checker;
  readonly globals: CheckerGlobals;
  readonly node: Node;
}

/** The native collection types an annotation may name, by the collection's kind. */
const NATIVES: Readonly<Record<'Map' | 'Set', readonly string[]>> = {
  Map: ['Map', 'ReadonlyMap', 'WeakMap'],
  Set: ['ReadonlySet', 'Set', 'WeakSet'],
};

/**
 * A declaration file, which may declare what the application reads as global: of the files a
 * configuration names, the ones a program of the modules alone would miss. Its other files the
 * modules import where they read them.
 */
const DECLARATION_FILE = /\.d\.[cm]?ts$/u;

/**
 * A file of the application's own: a rooted path, `/…` or a drive's `C:/…` as TypeScript writes
 * one on Windows, outside `node_modules`; no bundled library.
 */
const APPLICATION_FILE = /^(?:[A-Za-z]:)?\/(?!.*\/node_modules\/)/u;

/** Whether a file a program read is one of the application's own (`APPLICATION_FILE`). */
export function framedApplicationFile(file: string): boolean {
  return APPLICATION_FILE.test(file);
}

/** The language's and the platform's Error types. */
const ERROR_FAMILY = [
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'AggregateError',
  'DOMException',
];

/** Records which file `specifier`, written in `importer`, names: the compile's own choice of one. */
export type RecordResolution = (specifier: string, importer: string) => void;

/** What a parse was made of, and the session whose program reads it. */
interface Parsed {
  readonly session: TypeSession;
  readonly file: string;
  readonly text: string;
}

/** A program made of the session's texts under one `tsconfig.json`, and what it was made of. */
interface Checked {
  readonly dispose: () => void;
  readonly program: Program | undefined;
  readonly checker: Checker | undefined;
  readonly globals: CheckerGlobals | undefined;
  readonly texts: ReadonlyMap<string, string>;
  readonly files: Map<string, SourceFile | undefined>;
}

const PARSED = new WeakMap<SourceFile, Parsed>();
/** What a program TypeScript could not make disposes of: nothing. */
const keep = (): void => undefined;
/** The session of the parses made outside a compile, one an `API` holds as long as it lives. */
const DEFAULT_SESSIONS = new WeakMap<API, TypeSession>();

/** A compile's programs: made on the first question, made again as it reads, disposed of with it. */
export class TypeSession implements Disposable {
  readonly #api: API;
  readonly #texts = new Map<string, string>();
  readonly #configs = new Map<string, string>();
  readonly #programs = new Map<string, Checked>();
  /** What the programs read that no parse of the session's did, with its text as read. */
  readonly #reads = new Map<string, string>();
  /** The directory the compile writes into, whose files are no input of it. */
  readonly #written: string | undefined;
  /** Where the choice of file for each import a program holds is recorded; none outside a compile. */
  readonly #resolving: RecordResolution | undefined;
  /** The files whose imports were recorded, each once: a text is the same in every program. */
  readonly #resolved = new Set<string>();

  constructor(api: API, written?: string, resolving?: RecordResolution) {
    this.#api = api;
    this.#written = written === undefined ? undefined : `${path.resolve(written)}${path.sep}`;
    this.#resolving = resolving;
  }

  /** Whether a file is one the compile itself writes. */
  #output(file: string): boolean {
    return this.#written !== undefined && file.startsWith(this.#written);
  }

  #configOf(file: string): string {
    let config = this.#configs.get(file);
    if (config === undefined) {
      config = nearestTsconfig(file) ?? '';
      this.#configs.set(file, config);
    }
    return config;
  }

  /**
   * A program of every text the session read under `config`, and of the declaration files the
   * configuration names itself, with its parsed options, the defaults where there is none; one
   * whose program, or whose `Error`, TypeScript cannot give answers nothing, and every question of
   * it admits an Error.
   */
  #made(config: string): Checked {
    const texts = new Map([...this.#texts].filter(([file]) => this.#configOf(file) === config));
    const files = new Map<string, SourceFile | undefined>();
    try {
      const parsed = config === '' ? undefined : this.#api.parseConfigFile(config);
      const named = (parsed?.fileNames ?? []).filter(
        (file) => DECLARATION_FILE.test(file) && !this.#output(file),
      );
      const roots = new Set(texts.keys());
      for (const file of named) roots.add(file);
      const snapshot = this.#api.createSnapshot({
        fileSystem: { kind: 'layer', files: Object.fromEntries(texts) },
        createPrograms: [{ rootFiles: [...roots], compilerOptions: parsed?.options ?? {} }],
      } as never) as { readonly operation: SnapshotOperation; readonly dispose: () => void };
      const program = snapshot.operation.createdPrograms?.[0];
      const checker = program?.getProject().checker;
      if (program !== undefined) this.#record(program, config);
      const dispose = (): void => {
        snapshot.dispose();
      };
      return { dispose, program, checker, globals: checker && globalsOf(checker), texts, files };
    } catch {
      return {
        dispose: keep,
        program: undefined,
        checker: undefined,
        globals: undefined,
        texts,
        files,
      };
    }
  }

  /**
   * Records what a program read beside the session's parses: each source file of the application's
   * own, outside `node_modules` and the compiler's libraries, which a type-only import or the
   * configuration's file list brings in, and the configuration with each it extends. And, of each
   * application file the program holds, the file each of its imports names (`#recordImports`).
   */
  #record(program: Program, config: string): void {
    const configurations = config === '' ? [] : aliasesOf(config).files;
    for (const { file, text } of configurations) this.#reads.set(file, text);
    for (const file of program.getSourceFileNames()) {
      if (this.#output(file)) continue;
      this.#recordImports(program, file);
      if (this.#texts.has(file) || this.#reads.has(file)) continue;
      if (!framedApplicationFile(file)) continue;
      try {
        this.#reads.set(file, readFileSync(file, 'utf8'));
      } catch {
        // A file the program holds that the disk does not, as a layer gives, is the compile's own.
      }
    }
  }

  /**
   * Records the choice of file for each import of `file`, an application's own the program holds,
   * once for the session: the compile resolves what it reads itself, and an import of a type alone
   * is one it does not, which the checker resolves for it. The choice is the compile's own
   * (`moduleFile`) — the one a later build checks again against the disk, whatever the checker
   * took. Imports are TypeScript's list of a file's: declarations, `export … from`, `import x =
   * require()`, and a type's `import('…')`.
   */
  #recordImports(program: Program, file: string): void {
    const record = this.#resolving;
    if (record === undefined || this.#resolved.has(file) || !framedApplicationFile(file)) return;
    this.#resolved.add(file);
    const source = program.getSourceFile(file);
    if (source === undefined) return;
    for (const node of source.imports) {
      if (isStringLiteralLikeNode(node)) record(node.text, file);
    }
  }

  /** What the session's programs read that no parse of its did, with its text as read. */
  reads(): ReadonlyMap<string, string> {
    return this.#reads;
  }

  /** Records what a parse of the session's was made of. */
  add(sourceFile: SourceFile, fileName: string, text: string): void {
    const file = path.resolve(this.#api.getCurrentDirectory(), fileName);
    this.#texts.set(file, text);
    PARSED.set(sourceFile, { session: this, file, text });
  }

  /**
   * The program that holds `file` as `text`: the one made of the session's texts under the file's
   * `tsconfig.json`, made again where the file was read since it was made.
   */
  checked(file: string, text: string): Checked {
    const config = this.#configOf(file);
    const known = this.#programs.get(config);
    if (known?.texts.get(file) === text) return known;
    known?.dispose();
    const made = this.#made(config);
    this.#programs.set(config, made);
    return made;
  }

  [Symbol.dispose](): void {
    for (const checked of this.#programs.values()) checked.dispose();
    this.#programs.clear();
  }
}

/** The session the parses an `API` makes outside a compile record their texts with. */
export function defaultTypeSession(api: API): TypeSession {
  let session = DEFAULT_SESSIONS.get(api);
  if (session === undefined) {
    session = new TypeSession(api);
    DEFAULT_SESSIONS.set(api, session);
  }
  return session;
}

/** The global types a program's checker reads, by their ids; none where it has no `Error`. */
function globalsOf(checker: Checker): CheckerGlobals | undefined {
  const symbol = checker.resolveName('Error', SymbolFlags.Type);
  if (symbol === undefined) return undefined;
  return {
    error: checker.getDeclaredTypeOfSymbol(symbol),
    errorFamily: typeIds(checker, ERROR_FAMILY),
    natives: { Map: typeIds(checker, NATIVES.Map), Set: typeIds(checker, NATIVES.Set) },
  };
}

function typeIds(checker: Checker, names: readonly string[]): ReadonlySet<number> {
  const ids = new Set<number>();
  for (const name of names) {
    const symbol = checker.resolveName(name, SymbolFlags.Type);
    if (symbol !== undefined) ids.add(checker.getDeclaredTypeOfSymbol(symbol).id);
  }
  return ids;
}

/**
 * A node of a module's parse as the checker of its session's program reads it: the program's own
 * node at the same position, of the same kind. None for a parse no session recorded, a program
 * TypeScript could not make, or a node the program's file does not hold.
 */
export function framedChecked(node: Node): CheckedNode | undefined {
  const parsed = PARSED.get(node.getSourceFile());
  if (parsed === undefined) return undefined;
  const checked = parsed.session.checked(parsed.file, parsed.text);
  const { checker, globals, program } = checked;
  if (checker === undefined || globals === undefined || program === undefined) return undefined;
  let sourceFile = checked.files.get(parsed.file);
  if (!checked.files.has(parsed.file)) {
    sourceFile = program.getSourceFile(parsed.file);
    checked.files.set(parsed.file, sourceFile);
  }
  const found = sourceFile === undefined ? undefined : programNode(sourceFile, node);
  return found === undefined ? undefined : { checker, globals, node: found };
}

/** The node of the program's copy of a file at the same position as `target`, of its kind. */
function programNode(sourceFile: SourceFile, target: Node): Node | undefined {
  let at: Node = sourceFile;
  for (;;) {
    if (at.pos === target.pos && at.end === target.end && at.kind === target.kind) return at;
    let next: Node | undefined;
    at.forEachChild((child) => {
      if (next === undefined && child.pos <= target.pos && child.end >= target.end) next = child;
    });
    if (next === undefined) return undefined;
    at = next;
  }
}
