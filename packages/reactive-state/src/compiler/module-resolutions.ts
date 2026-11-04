import { realpathSync } from 'node:fs';
import path from 'node:path';

import {
  type Aliases,
  aliasesOf,
  fileFor,
  nearestTsconfig,
  NO_ALIASES,
  resolveAlias,
  typescriptFor,
} from '../authority/aliases.ts';

/** Original module choices, retained privately with a compile's existing read map. */
export interface ModuleResolution {
  readonly importer: string;
  readonly specifier: string;
  readonly file: string | null;
}

const READ_RESOLUTIONS = new WeakMap<ReadonlyMap<string, string>, readonly ModuleResolution[]>();
/** Relative or absolute module paths; other spellings go through the importer's aliases. */
const PATH = /^(?:\.{1,2}(?:\/|$)|\/)/u;

/** The same local resolution used by admission and by the later build-cache check. */
export function moduleFile(
  specifier: string,
  importer: string,
  aliases: () => Aliases,
): string | undefined {
  const candidate = PATH.test(specifier)
    ? path.resolve(path.dirname(importer), specifier)
    : undefined;
  const file =
    candidate === undefined
      ? resolveAlias(aliases(), specifier)
      : (typescriptFor(candidate) ?? fileFor(candidate));
  if (file === undefined) return undefined;
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

/** Resolution metadata belongs to this particular read map, without changing its public entries. */
export function rememberModuleResolutions(
  reads: ReadonlyMap<string, string>,
  resolutions: readonly ModuleResolution[],
): ReadonlyMap<string, string> {
  READ_RESOLUTIONS.set(reads, resolutions);
  return reads;
}

/** The decisions observed during this compile, rather than a later filesystem snapshot. */
export function moduleResolutionsOf(
  reads: ReadonlyMap<string, string>,
): readonly ModuleResolution[] {
  return READ_RESOLUTIONS.get(reads) ?? [];
}

/** The private digest's resolution records, including previously absent local candidates. */
export function isModuleResolutions(value: unknown): value is readonly ModuleResolution[] {
  return Array.isArray(value) && value.every((item: unknown) => isModuleResolution(item));
}

function isModuleResolution(value: unknown): value is ModuleResolution {
  if (typeof value !== 'object' || value === null) return false;
  const { importer, specifier, file } = value as Partial<Record<string, unknown>>;
  return (
    typeof importer === 'string' &&
    typeof specifier === 'string' &&
    (file === null || typeof file === 'string')
  );
}

/** Each stored local choice still selects the same canonical file from the current project. */
export function moduleResolutionsHold(
  projectDir: string,
  resolutions: readonly ModuleResolution[],
): boolean {
  const configurations = new Map<string, Aliases>();
  const aliasesFor = (importer: string): Aliases => {
    const config = nearestTsconfig(importer);
    if (config === undefined) return NO_ALIASES;
    let aliases = configurations.get(config);
    if (aliases === undefined) {
      aliases = aliasesOf(config);
      configurations.set(config, aliases);
    }
    return aliases;
  };
  try {
    return resolutions.every(({ importer, specifier, file }) => {
      const source = path.resolve(projectDir, importer);
      const current = moduleFile(specifier, source, () => aliasesFor(source));
      return current === (file === null ? undefined : path.resolve(projectDir, file));
    });
  } catch {
    return false;
  }
}
