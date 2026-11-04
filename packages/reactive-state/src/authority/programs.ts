import {
  type ComponentProgram,
  type OperationModule,
  type ProgramUpdater,
  PROTOCOL_VERSION,
} from '../program.ts';

/**
 * What the engine checks of what a compile wrote for it, before anything is served: each
 * component's program, the server operations its components import, and the one build they are
 * all of. What fails is the application's fault, never a session's refusal.
 */

/** A build's id, as a compile names it (`buildId`), which every token names too. */
const BUILD_ID = /^[\w-]{1,128}$/u;
/** The longest id a component or a module takes: a path in the application. */
const MAX_ID_LENGTH = 256;
/** What no segment of an id holds: a space, a control character, or a backslash. */
const UNSAFE = /[\s\\]/u;

/** What the engine runs: every component and server operation of one build. */
export interface Registry {
  readonly buildId: string;
  /** Each component's program, by its id. */
  readonly programs: ReadonlyMap<string, ComponentProgram>;
  /** Each `'use server'` module a component imports, by its id. */
  readonly operations: ReadonlyMap<string, OperationModule>;
}

/** What a compile writes for the authority (`<out>/authority.mts`), as the engine is given it. */
export interface RegistryOptions {
  readonly programs: readonly ComponentProgram[];
  readonly operations?: Readonly<Record<string, OperationModule>> | undefined;
  /** The compile's build; the programs' own where it is not given. */
  readonly buildId?: string | undefined;
}

/**
 * Whether `id` names a component or a module as a compile does: its path in the application,
 * segments joined by `/`, none of them empty, `.` or `..`.
 */
function isModuleId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length <= MAX_ID_LENGTH &&
    id
      .split('/')
      .every(
        (segment) => segment !== '' && segment !== '.' && segment !== '..' && !UNSAFE.test(segment),
      )
  );
}

function isStrings(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string') &&
    new Set(value).size === value.length
  );
}

/** Why `updater` is none a program may register, or nothing when it is one. */
function malformedUpdater(
  id: string,
  updater: unknown,
  writable: readonly string[],
): string | undefined {
  const { apply, keys, kind } = (
    typeof updater === 'object' && updater !== null ? updater : {}
  ) as Partial<Record<'apply' | 'keys' | 'kind', unknown>>;
  const registered = kind === 'apply' ? typeof apply === 'function' : kind === 'set';
  if (!registered || !isStrings(keys) || keys.length === 0) {
    return `registers ${id}, which is neither an \`apply\` nor a \`set\` of its states' keys`;
  }
  const other = keys.find((key) => !writable.includes(key));
  return other === undefined
    ? undefined
    : `registers ${id} for \`${other}\`, which is none of the states it has a setter for`;
}

/**
 * Why `program` is no program a compile writes for this authority; nothing when it is one. One
 * compiled for another protocol would render pages in words they do not read.
 */
function malformed(program: ComponentProgram): string | undefined {
  const { buildId, evaluate, protocolVersion, updaters, writable } = program as unknown as Readonly<
    Record<keyof ComponentProgram, unknown>
  >;
  if (protocolVersion !== PROTOCOL_VERSION) {
    return `was compiled for protocol ${String(protocolVersion)}, and this authority speaks ${String(PROTOCOL_VERSION)}: compile the application again`;
  }
  if (
    typeof buildId !== 'string' ||
    typeof evaluate !== 'function' ||
    typeof updaters !== 'object' ||
    updaters === null ||
    !BUILD_ID.test(buildId) ||
    !isStrings(writable)
  ) {
    return 'is not one a compile writes, which names its build and has `evaluate`, `writable` and `updaters`';
  }
  for (const [id, updater] of Object.entries(updaters)) {
    const wrong = malformedUpdater(id, updater, writable);
    if (wrong !== undefined) {
      return wrong;
    }
  }
  return undefined;
}

/**
 * A program as it was given and checked, whatever becomes of the object it was given as: its
 * keys and updates copied, and all of it frozen, so that what a running authority serves is what
 * it checked, under the build its tokens name.
 */
function snapshotOf(program: ComponentProgram): ComponentProgram {
  const updaters: Record<string, ProgramUpdater> = {};
  for (const [id, updater] of Object.entries(program.updaters)) {
    const keys = Object.freeze([...updater.keys]);
    Object.defineProperty(updaters, id, {
      enumerable: true,
      value: Object.freeze({ ...updater, keys }),
    });
  }
  return Object.freeze({
    buildId: program.buildId,
    component: program.component,
    evaluate: program.evaluate.bind(program),
    protocolVersion: program.protocolVersion,
    updaters: Object.freeze(updaters),
    writable: Object.freeze([...program.writable]),
  });
}

function programsOf(
  programs: readonly ComponentProgram[],
  build: string | undefined,
): {
  readonly buildId: string | undefined;
  readonly programs: ReadonlyMap<string, ComponentProgram>;
} {
  const byComponent = new Map<string, ComponentProgram>();
  let buildId = build;
  for (const program of programs) {
    const { component } = program as { readonly component: unknown };
    if (!isModuleId(component)) {
      throw new Error(
        'A component program names its component (`component`) by its path in the application.',
      );
    }
    const wrong = malformed(program);
    if (wrong !== undefined) {
      throw new Error(`The program of ${component} ${wrong}.`);
    }
    buildId ??= program.buildId;
    if (program.buildId !== buildId) {
      throw new Error(
        `The program of ${component} is of build ${program.buildId}, and the application's is ${buildId}: an authority runs one compile.`,
      );
    }
    if (byComponent.has(component)) {
      throw new Error(
        `Two programs are of ${component}: the authority knows a component by its id.`,
      );
    }
    byComponent.set(component, snapshotOf(program));
  }
  return { buildId, programs: byComponent };
}

function operationsOf(
  operations: Readonly<Record<string, OperationModule>>,
): ReadonlyMap<string, OperationModule> {
  const byModule = new Map<string, OperationModule>();
  for (const [module, exports] of Object.entries(operations) as [string, unknown][]) {
    if (typeof exports !== 'object' || exports === null || !isModuleId(module)) {
      throw new Error(`The server operations of ${module} are not a module the authority can run.`);
    }
    byModule.set(module, exports as OperationModule);
  }
  return byModule;
}

/**
 * What a compile wrote, checked: every program of one build — the one given, or the programs'
 * own — each of one component, and each server operation module by its id.
 */
export function registryOf(options: RegistryOptions): Registry {
  const { buildId, programs } = programsOf(options.programs, options.buildId);
  if (buildId === undefined || !BUILD_ID.test(buildId)) {
    throw new Error(
      'The authority is given the build of the compile it runs: `buildId`, or a program of it.',
    );
  }
  return { buildId, operations: operationsOf(options.operations ?? {}), programs };
}
