import type { D1Binding } from './client.ts';

/**
 * The D1 database a deployed `reactiveDb` reads, of the bindings it has: a Durable Object's, the one
 * of its environment — of no host's names, whatever a host lists beside, as the object reads
 * its site of its own (`REACTIVE_SITE_URL`) — and a Function's, of what its runtime publishes
 * (`upwind.resources`). Of several, the application names one; of none, it says so.
 */

/** Where a deployment's runtime publishes its bindings to its Function. */
const RESOURCES = Symbol.for('upwind.resources');
/** The shape of what it publishes that this reads: another is read as nothing published. */
const RESOURCES_VERSION = 1;

/**
 * Whether `value` answers D1's methods: what an application's name of it, or a runtime's type of
 * it, says is D1's — as a proxy that answers any method of its name is, of a workflow's runtime.
 */
function answersD1(value: unknown): value is D1Binding {
  if (typeof value !== 'object' || value === null) return false;
  const methods = value as Readonly<Record<string, unknown>>;
  return (
    typeof methods['prepare'] === 'function' &&
    typeof methods['batch'] === 'function' &&
    typeof methods['exec'] === 'function'
  );
}

/**
 * Whether `value` is a binding of D1's, of nothing that says so but its methods: a service's binding
 * or an object's stub answers any method of its name, `fetch` too, which D1's binding holds not.
 */
function isD1(value: unknown): value is D1Binding {
  return answersD1(value) && typeof Reflect.get(value, 'fetch') !== 'function';
}

/**
 * The D1 database of `bindings` the application reads: `name`'s, where it gives one, or else the
 * one of `candidates`. `where` says of a refusal where the databases are.
 */
function chosenD1(
  bindings: Readonly<Record<string, unknown>>,
  candidates: readonly string[],
  name: string | undefined,
  where: string,
): D1Binding {
  if (name !== undefined) {
    const named = bindings[name];
    if (!answersD1(named)) throw new TypeError(`${name} is no D1 database ${where}.`);
    return named;
  }
  const [only, ...more] = candidates;
  if (only === undefined) {
    throw new TypeError(
      `No D1 database is ${where}, which \`reactiveDb\` of a schema of SQLite reads.`,
    );
  }
  if (more.length > 0) {
    throw new TypeError(
      `${String(candidates.length)} D1 databases are ${where} (${candidates.join(', ')}): name the application's, as reactiveDb(schema, { binding: '${only}' }).`,
    );
  }
  return bindings[only] as D1Binding;
}

/**
 * The D1 database of `env` the application reads: `name`'s, where it gives one, or else the one
 * binding of its own that is D1's. `where` says of a refusal where the databases are.
 */
export function boundD1(
  env: Readonly<Record<string, unknown>>,
  name?: string,
  where = 'bound to this Worker',
): D1Binding {
  const candidates = Object.keys(env).filter((key) => isD1(env[key]));
  return chosenD1(env, candidates, name, where);
}

/**
 * The D1 database a deployment's Function reads, of what its runtime publishes in the shape of
 * version 1: `name`'s, or its one. None where nothing is published, or in another shape — a process
 * of Node's, whose D1 is a file — and a refusal where what is published holds no D1, or several of
 * no name.
 */
export function publishedD1(name?: string): D1Binding | undefined {
  const published = (globalThis as Partial<Record<symbol, unknown>>)[RESOURCES];
  if (typeof published !== 'object' || published === null) return undefined;
  const resources: unknown = Reflect.get(published, 'resources');
  const version: unknown = Reflect.get(published, 'version');
  if (resources === null || typeof resources !== 'object' || version !== RESOURCES_VERSION) {
    return undefined;
  }
  const d1 = Object.entries(resources).flatMap(
    ([key, resource]: [string, unknown]): [string, unknown][] => {
      if (resource === null || typeof resource !== 'object') return [];
      const binding: unknown = Reflect.get(resource, 'binding');
      return Reflect.get(resource, 'type') === 'd1' ? [[key, binding]] : [];
    },
  );
  // Of the type the runtime published it of, whatever its methods answer.
  const bindings = Object.fromEntries(d1);
  const candidates = Object.keys(bindings).filter((key) => answersD1(bindings[key]));
  return chosenD1(bindings, candidates, name, 'published to this deployment');
}
