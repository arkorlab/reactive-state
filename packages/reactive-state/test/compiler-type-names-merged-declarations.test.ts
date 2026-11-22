import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isTypeAliasDeclaration } from 'typescript/ast';
import { afterEach, describe, expect, it } from 'vitest';

import { nonJsonPart } from '../src/compiler/json-types.ts';
import { Modules } from '../src/compiler/modules.ts';
import { typeReading } from '../src/compiler/type-names.ts';
import { openTypeScript, parseModule } from '../src/compiler/typescript.ts';

/**
 * A name a file declares more than once as a type — an interface twice, an interface beside a class,
 * an enum twice — is one type of several declarations that TypeScript merges. The reader took the
 * first, so `interface State { id: string }` beside `interface State { callback: () => void }` was
 * read by its first body and taken. A name declared more than once is a type the compile cannot
 * read: in the file that declares it, and where the file exports it. A namespace of the name adds
 * nothing to the type, a constant or a function of the name is a value, and an interface inside
 * `declare global` or `declare module` is not a statement of the file's own: none of them is a
 * second declaration.
 */

const api = openTypeScript();

const dirs: string[] = [];

/** The message of a type the compile cannot read, as `nonJsonPart` words it. */
const UNREAD = 'a type the compile cannot read';

/** What `nonJsonPart` answers of `probe`, which `files` of an application may import from. */
function walkOfProbe(
  files: Readonly<Record<string, string>>,
  probeText: string,
): { readonly admits: string | undefined; readonly part: string | undefined } {
  const dir = mkdtempSync(path.join(tmpdir(), 'reactive-state-merged-declarations-'));
  dirs.push(dir);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  const probe = path.join(dir, 'probe.ts');
  using parsed = parseModule(api, probe, probeText);
  using modules = new Modules(api, dir);
  const { sourceFile } = parsed;
  const state = sourceFile.statements.find(
    (statement) => isTypeAliasDeclaration(statement) && statement.name.text === 'Root',
  );
  if (state === undefined || !isTypeAliasDeclaration(state)) {
    throw new Error('no Root');
  }
  const found = nonJsonPart(state.type, { file: probe, sourceFile }, typeReading(modules));
  return { admits: found?.admits, part: found?.part };
}

interface Case {
  readonly id: string;
  /** What the file that declares the types holds, imported from by the probe as `./barrel`. */
  readonly barrel?: string;
  /** The probe: where the state is written, `type Root = …`. */
  readonly probe: string;
  /** The part found, as the code writes it; none where the type is JSON all through. */
  readonly part: string | undefined;
  /** Whether it is refused as a type the compile cannot read. */
  readonly unread?: boolean;
}

const IMPORT = "import type { State } from './barrel'; type Root = State;";

const CASES: readonly Case[] = [
  {
    id: 'an-interface-declared-twice',
    probe:
      'interface State { id: string } interface State { callback: () => void } type Root = State;',
    part: 'State',
    unread: true,
  },
  {
    id: 'an-interface-declared-twice-with-members-of-JSON',
    probe: 'interface State { id: string } interface State { title: string } type Root = State;',
    part: 'State',
    unread: true,
  },
  {
    id: 'an-interface-beside-a-class-of-its-name',
    probe: 'interface State { id: string } class State { callback = () => {}; } type Root = State;',
    part: 'State',
    unread: true,
  },
  {
    id: 'a-class-before-an-interface-of-its-name',
    probe: 'class State { id = 1; } interface State { title: string } type Root = State;',
    part: 'State',
    unread: true,
  },
  {
    id: 'an-enum-declared-twice',
    probe: 'enum State { A = 1 } enum State { B = 1e999 } type Root = State;',
    part: 'State',
    unread: true,
  },
  {
    id: 'a-merged-interface-an-interface-extends',
    probe:
      'interface Base { id: string } interface Base { run: () => void } interface State extends Base { n: number } type Root = State;',
    part: 'State',
    unread: true,
  },
  {
    id: 'a-merged-interface-as-the-type-of-a-member',
    probe:
      'interface Held { id: string } interface Held { run: () => void } type Root = { held: Held };',
    part: 'Held',
    unread: true,
  },
  {
    id: 'a-merged-interface-listed-in-an-export',
    barrel: 'interface State { id: string } interface State { run: () => void } export { State };',
    probe: IMPORT,
    part: 'State',
    unread: true,
  },
  {
    id: 'an-exported-interface-declared-twice',
    barrel: 'export interface State { id: string } export interface State { run: () => void }',
    probe: IMPORT,
    part: 'State',
    unread: true,
  },
  {
    id: 'an-exported-interface-and-an-exported-class-of-its-name',
    barrel: 'export interface State { run: () => void } export class State { id = 1; }',
    probe: IMPORT,
    part: 'State',
    unread: true,
  },
  {
    id: 'an-exported-enum-declared-twice',
    barrel: 'export enum State { A = 1 } export enum State { B = 2 }',
    probe: IMPORT,
    part: 'State',
    unread: true,
  },
  {
    id: 'an-interface-declared-once',
    probe: 'interface State { id: string; names: string[] } type Root = State;',
    part: undefined,
  },
  {
    id: 'an-interface-declared-once-with-a-function',
    probe: 'interface State { id: string; run: () => void } type Root = State;',
    part: '() => void',
  },
  {
    id: 'two-interfaces-of-two-names',
    probe: 'interface A { id: string } interface B { title: string } type Root = { a: A; b: B };',
    part: undefined,
  },
  {
    id: 'an-interface-beside-a-namespace-of-its-name',
    probe:
      'interface State { id: string } namespace State { export const make = (): State => ({ id: "" }); } type Root = State;',
    part: undefined,
  },
  {
    id: 'an-interface-with-a-function-beside-a-namespace-of-its-name',
    probe:
      'interface State { run: () => void } namespace State { export const none = 1; } type Root = State;',
    part: '() => void',
  },
  {
    id: 'an-interface-beside-a-constant-of-its-name',
    probe: "const State = { id: '' }; interface State { id: string } type Root = State;",
    part: undefined,
  },
  {
    id: 'an-alias-beside-a-constant-of-its-name',
    probe: "const State = { a: 'a' } as const; type State = 'a' | 'b'; type Root = State;",
    part: undefined,
  },
  {
    id: 'an-interface-beside-a-function-of-its-name',
    probe: 'function State() {} interface State { id: string } type Root = State;',
    part: undefined,
  },
  {
    id: 'an-interface-beside-one-of-its-name-in-declare-global',
    probe:
      'declare global { interface State { run: () => void } } interface State { id: string } type Root = State;',
    part: undefined,
  },
  {
    id: 'an-interface-beside-one-of-its-name-in-declare-module',
    probe:
      "declare module 'package' { interface State { run: () => void } } interface State { id: string } type Root = State;",
    part: undefined,
  },
  {
    id: 'an-exported-constant-and-an-exported-alias-of-one-name',
    barrel: "export const State = { a: 'a' } as const; export type State = 'a' | 'b';",
    probe: IMPORT,
    part: undefined,
  },
  {
    id: 'an-exported-interface-beside-an-exported-namespace-of-its-name',
    barrel:
      'export interface State { id: string } export namespace State { export const none = 1; }',
    probe: IMPORT,
    part: undefined,
  },
  {
    id: 'an-exported-interface-declared-once',
    barrel: 'export interface State { id: string; run: () => void }',
    probe: IMPORT,
    part: '() => void',
  },
];

describe('a name that a file declares more than once as a type', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it.each(CASES)('$id', ({ barrel = 'export {};', part, probe, unread = false }) => {
    const walk = walkOfProbe({ 'barrel.ts': barrel }, probe);

    expect({ part: walk.part, unread: walk.admits === UNREAD }).toStrictEqual({ part, unread });
  });
});
