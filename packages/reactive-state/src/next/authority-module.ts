import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { GENERATED, isGeneratedFile } from '../compiler/app-route.ts';
import {
  DURABLE_OBJECT_CLASS,
  DURABLE_OBJECT_MODULE,
  relativeSpecifier,
} from '../compiler/emit-app.ts';
import { writeWhole } from './write-whole.ts';

/**
 * The module a host imports the authority's Durable Object from, where it registers the object the
 * compile writes (`ReactiveAuthority` of `<out>/durable-object.mjs`) by a module of its own
 * choosing: the deployment host registers `.reactive/durable-object.mjs`, whatever `out` the
 * application gives the compile, and bundles what that names. Such a host says so as it builds, in
 * `REACTIVE_AUTHORITY_MODULE`, by the module's path from the application's root; a compile that
 * writes the object elsewhere then writes a module there of one line, which re-exports the class
 * from where it wrote it. It opens as every file a compile writes does (`GENERATED`), and is never
 * written over a file of the application's.
 */

const AUTHORITY_MODULE_ENV = 'REACTIVE_AUTHORITY_MODULE';

/** The application's root, and where the compile writes, each by its absolute path. */
interface Placed {
  readonly projectDir: string;
  readonly outDir: string;
}

/** The variables a build runs with: `process.env` unless said. */
type Environment = Readonly<Record<string, string | undefined>>;

/** The module to write where the host imports the object from, by its absolute path. */
interface AuthorityModule {
  readonly file: string;
  readonly text: string;
}

/** Whether `left` and `right` are one file: by their paths, or by where their links lead. */
function sameFile(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/**
 * The module to write where the host imports the object from (`REACTIVE_AUTHORITY_MODULE` of
 * `environment`): none where it names none, nor where the compile writes the object there itself,
 * of the default `out`. Refused where it names no file under the application's root.
 */
function declaredAuthorityModule(
  placed: Placed,
  environment: Environment = process.env,
): AuthorityModule | undefined {
  const declared = environment[AUTHORITY_MODULE_ENV];
  if (declared === undefined || declared === '') {
    return undefined;
  }
  const file = path.resolve(placed.projectDir, declared);
  const relative = path.relative(placed.projectDir, file);
  if (
    relative === '' ||
    relative === '..' ||
    path.isAbsolute(declared) ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(
      `${AUTHORITY_MODULE_ENV} is \`${declared}\`: it names the module a host imports the authority's object from by its path from the application's root, a file under it.`,
    );
  }
  const compiled = path.join(placed.outDir, DURABLE_OBJECT_MODULE);
  if (sameFile(file, compiled)) {
    return undefined;
  }
  return {
    file,
    text: [
      `${GENERATED} for a host that imports the authority's object from here (${AUTHORITY_MODULE_ENV}). Do not edit: it re-exports what the compile writes into its \`out\`.`,
      `export { ${DURABLE_OBJECT_CLASS} } from ${relativeSpecifier(file, compiled)};`,
      '',
    ].join('\n'),
  };
}

/**
 * Writes the module the host imports the object from where the compile writes the object elsewhere
 * (`declaredAuthorityModule`), whole; over a file a compile wrote — an earlier one's of the default
 * `out` too — but never over the application's own, which is refused. Answers whether it changed
 * anything.
 */
export function writeAuthorityModule(
  placed: Placed,
  environment: Environment = process.env,
): boolean {
  const module = declaredAuthorityModule(placed, environment);
  if (module === undefined) {
    return false;
  }
  if (lstatSync(module.file, { throwIfNoEntry: false }) !== undefined) {
    if (!isGeneratedFile(module.file)) {
      const shown = path.relative(placed.projectDir, module.file);
      throw new Error(
        `${AUTHORITY_MODULE_ENV} names \`${shown}\`, where the host imports the authority's object from, and the application has a file of its own there, which @arkorlab/reactive-state does not write over: take it away, for the compile to write there the module that re-exports the object.`,
      );
    }
    if (readFileSync(module.file, 'utf8') === module.text) {
      return false;
    }
  }
  writeWhole(module.file, module.text);
  return true;
}
