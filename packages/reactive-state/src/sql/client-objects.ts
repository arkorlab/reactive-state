import { tableReads, usedConnection } from '../server/context.ts';
import type { Connection } from './client-plans.ts';

/** What `result` settles to, the receiver's facade where it settles to the receiver. */
async function settledReceiver(
  result: Promise<unknown>,
  receiver: unknown,
  facade: unknown,
): Promise<unknown> {
  const value: unknown = await result;
  return value === receiver ? facade : value;
}

/** A method's receiver stays guarded when the method returns it, synchronously or as a promise. */
export function retainedReceiver(result: unknown, receiver: unknown, facade: unknown): unknown {
  if (result === receiver) return facade;
  return result instanceof Promise ? settledReceiver(result, receiver, facade) : result;
}

/** What `first` and `rest`, as `query` was called, say of a callback, or of an object's own. */
export function callbackOf(first: unknown, rest: readonly unknown[]): unknown {
  const beside = rest.find((each) => typeof each === 'function');
  if (beside !== undefined || typeof first !== 'object' || first === null) return beside;
  return Reflect.get(first, 'callback');
}

/** Whether `first` is a submittable (`pg`'s `Query`), which answers by its own events. */
function submittable(
  first: unknown,
): first is { once: (...args: unknown[]) => unknown; constructor: unknown } {
  return (
    typeof first === 'object' &&
    first !== null &&
    typeof Reflect.get(first, 'submit') === 'function' &&
    typeof Reflect.get(first, 'once') === 'function'
  );
}

/** `callback`, wrapped to call `over` first and then run as it was: its receiver, arguments, answer. */
function calling(callback: unknown, over: () => void): (...answer: unknown[]) => unknown {
  return function calls(this: unknown, ...answer: unknown[]): unknown {
    over();
    return Reflect.apply(callback as (...all: unknown[]) => unknown, this, answer);
  };
}

/**
 * `args` of a `query` call with the callback it names — beside the text, or an object's own —
 * wrapped once to call `over` just before it runs; the call's arguments as they are where it names
 * none. A submittable's `end`, or its error as the emitter's monitor sees it, calls `over` instead,
 * whichever comes first.
 */
function overAtAnswer(args: readonly unknown[], over: () => void): readonly unknown[] | undefined {
  const [first, ...rest] = args;
  if (submittable(first)) {
    // First among the `end` listeners, the application's own, registered before this call, too.
    const prepend: unknown = Reflect.get(first, 'prependOnceListener');
    if (typeof prepend === 'function') Reflect.apply(prepend, first, ['end', over]);
    else first.once('end', over);
    // A statement with a callback of its own answers it, and on an error emits no `end`: pg reads
    // `callback` as it answers, so a wrapper in its place runs first, as the callback would.
    const own: unknown = Reflect.get(first, 'callback');
    let sent = args;
    if (typeof own === 'function') {
      Reflect.set(first, 'callback', calling(own, over));
    } else if (rest.some((each) => typeof each === 'function')) {
      sent = [
        first,
        ...rest.map((each) => (typeof each === 'function' ? calling(each, over) : each)),
      ];
    }
    // An `'error'` listener of ours would count as the application's handler, and swallow an error
    // nothing else handles: the emitter's error monitor runs beside them and changes nothing. Read
    // off the emitter's own class, so that no module of `node:events` is imported here; where it
    // names none, the end alone releases the statement.
    const emitter: unknown = first.constructor;
    const monitor: unknown =
      typeof emitter === 'function' ? Reflect.get(emitter, 'errorMonitor') : undefined;
    if (typeof monitor === 'symbol') first.once(monitor, over);
    return sent;
  }
  const callback = callbackOf(first, rest);
  if (typeof callback !== 'function') return undefined;
  const wrapped = (...answer: unknown[]): unknown => {
    over();
    return Reflect.apply(callback, undefined, answer);
  };
  if (rest.includes(callback))
    return [first, ...rest.map((each) => (each === callback ? wrapped : each))];
  return [{ ...(first as Record<string, unknown>), callback: wrapped }, ...rest];
}

/**
 * `run`, a `query` of the application's own tables the operation under way sends with `args`,
 * counted as under way until PostgreSQL answers it, in whatever form: a promise settling, a
 * callback about to run, a submittable ending. Run as it is outside an operation.
 */
export function underwayQuery(
  args: readonly unknown[],
  run: (sent: readonly unknown[]) => unknown,
): unknown {
  const over = usedConnection({}, () => true);
  if (over === undefined) return run(args);
  const handed = overAtAnswer(args, over);
  let answered: unknown;
  try {
    answered = run(handed ?? args);
  } catch (error) {
    over();
    throw error;
  }
  // One reaction for both outcomes, registered before the caller's: whatever awaits it goes on after.
  // eslint-disable-next-line unicorn/prefer-then-catch -- a `.catch` would run a tick after a rejection
  if (answered instanceof Promise) void answered.then(over, over);
  else if (handed === undefined) over();
  return answered;
}

/** A rejection with `reason`, which no one need await: it is no unhandled rejection. */
export function rejection(reason: unknown): Promise<never> {
  const settled: Error = reason as Error;
  const rejected = Promise.reject(settled);
  void rejected.catch(() => {
    // Whoever awaits it hears it; one nobody awaits is no fault of the process.
  });
  return rejected;
}

/** The language's own `then`. */
const OWN_THEN = Reflect.get(Promise.prototype, 'then') as (...args: unknown[]) => unknown;

/**
 * What a refused call answers, noted as the render's whatever its code does with the answer. What
 * awaits a thenable reads the callbacks it handed `then`, never what `then` returns, so a refused
 * `then` rejects through them or that await would never settle.
 */
export function refusalOf(
  refusal: Promise<void>,
  key: PropertyKey,
  args: readonly unknown[],
): unknown {
  const answer =
    key === 'then' ? (Reflect.apply(OWN_THEN, refusal, args) as typeof refusal) : refusal;
  void answer.catch(() => {
    // Noted as the render's, whatever its code does with this answer.
  });
  return answer;
}

/**
 * A connection's object-valued namespaces with their methods guarded at call time. A namespace
 * or a method captured before a render cannot bypass the render's tracking boundary. A facade
 * permits guarding a frozen extension too, without violating Proxy's property invariants.
 */
export function guardedObjects(
  refused: (name: string) => Promise<never>,
): (value: unknown, name: string) => unknown {
  const proxies = new WeakMap<WeakKey, unknown>();
  const wrap = (value: unknown, name: string): unknown => {
    if (typeof value !== 'object' || value === null) return value;
    const kept = proxies.get(value);
    if (kept !== undefined) return kept;
    const proxy: Record<PropertyKey, unknown> = new Proxy(
      {},
      {
        get: (_target, key) => {
          const member: unknown = Reflect.get(value, key);
          const path = `${name}.${String(key)}`;
          if (typeof member !== 'function') return wrap(member, path);
          return (...args: unknown[]): unknown => {
            const noted = tableReads();
            if (noted !== undefined) {
              return refusalOf(
                noted(() => refused(path)),
                key,
                args,
              );
            }
            return retainedReceiver(Reflect.apply(member, value, args), value, proxy);
          };
        },
        getOwnPropertyDescriptor: (_target, key) => {
          const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
          if (descriptor === undefined) return;
          return {
            configurable: true,
            enumerable: descriptor.enumerable === true,
            get: (): unknown => Reflect.get(proxy, key),
          };
        },
        getPrototypeOf: () => Reflect.getPrototypeOf(value),
        set: (_target, key, next: unknown) => Reflect.set(value, key, next),
        deleteProperty: (_target, key) => Reflect.deleteProperty(value, key),
        // A fixed definition on the empty facade would violate Proxy's invariants. Such fields
        // can be configured on the original connection before it is followed, as frozen plugins are.
        defineProperty: (_target, key, descriptor) => {
          return (
            descriptor.configurable !== false && Reflect.defineProperty(value, key, descriptor)
          );
        },
        has: (_target, key) => Reflect.has(value, key),
        ownKeys: () => Reflect.ownKeys(value),
      },
    );
    proxies.set(value, proxy);
    return proxy;
  };
  return wrap;
}

/**
 * `connection` as a render may hold it: a member `wrapped` answers is that, any other method what
 * `refused` makes of its name, a fault in a render, and any other value what `valued` makes of it.
 */
export function facadeOf<C extends Connection>(
  connection: C,
  wrapped: Readonly<Record<string, unknown>>,
  refused: (key: PropertyKey) => unknown,
  valued: (value: unknown, key: PropertyKey) => unknown,
): C {
  const facade: C = new Proxy(connection, {
    // Read from the connection itself: its getters may read private fields, which a proxy has none of.
    get: (target, key) => {
      if (typeof key === 'string' && Object.hasOwn(wrapped, key)) {
        return wrapped[key];
      }
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== 'function') return valued(value, key);
      // Any other method, by a name or a symbol: the connection's own outside a render, a fault in
      // one.
      return refused(key);
    },
    // A member by its descriptor, as by its name: but one the connection fixed and may not write,
    // of which a proxy may answer nothing else, and an accessor of no getter, which has none to read.
    getOwnPropertyDescriptor: (target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (descriptor === undefined) return;
      const read = (): unknown => Reflect.get(facade, key);
      if ('value' in descriptor) {
        const fixed = descriptor.configurable !== true && descriptor.writable !== true;
        return fixed ? descriptor : { ...descriptor, value: read() };
      }
      const open = descriptor.configurable === true && descriptor.get !== undefined;
      return open ? { ...descriptor, get: read } : descriptor;
    },
  });
  return facade;
}
