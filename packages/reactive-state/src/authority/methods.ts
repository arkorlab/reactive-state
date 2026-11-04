/** The actual function a site's method call invokes, including native aliases hidden by getters or proxies. */

type Accepts = (receiver: unknown) => boolean;
/** The lib's inherited methods of all JavaScript values, rather than a boxed primitive. */
// eslint-disable-next-line @typescript-eslint/no-wrapper-object-types
type MethodObject = Object;
/** A receiver's own signature, with inherited Object methods only where its type has no key. */
type MethodValue<T, K extends PropertyKey> = K extends keyof NonNullable<T>
  ? NonNullable<T>[K]
  : MethodObject[K & keyof MethodObject];
interface Place {
  readonly key: PropertyKey;
  readonly accepts: Accepts;
}
interface Holder {
  readonly value: Readonly<Record<PropertyKey, unknown>>;
  readonly accepts: Accepts;
}

const STRING_VALUE: unknown = Reflect.get(String.prototype, 'valueOf');
const NUMBER_VALUE: unknown = Reflect.get(Number.prototype, 'valueOf');
const BOOLEAN_VALUE: unknown = Reflect.get(Boolean.prototype, 'valueOf');

/** Whether an intrinsic valueOf accepts the receiver's internal brand, without user conversions. */
function branded(receiver: unknown, valueOf: unknown): boolean {
  try {
    Reflect.apply(valueOf as (...given: readonly unknown[]) => unknown, receiver, []);
    return true;
  } catch {
    return false;
  }
}

/** A method's canonical prototype holder and the receivers whose native semantics its name describes. */
const PROTOTYPES: readonly Holder[] = [
  {
    accepts: (value) => Array.isArray(value),
    value: Array.prototype as unknown as Holder['value'],
  },
  {
    accepts: (value) => branded(value, STRING_VALUE),
    value: String.prototype as unknown as Holder['value'],
  },
  {
    accepts: (value) => branded(value, NUMBER_VALUE),
    value: Number.prototype as unknown as Holder['value'],
  },
  {
    accepts: (value) => branded(value, BOOLEAN_VALUE),
    value: Boolean.prototype as unknown as Holder['value'],
  },
  {
    accepts: (value) => value !== null && value !== undefined,
    value: Object.prototype as Holder['value'],
  },
  {
    accepts: (value) => typeof value === 'function',
    value: Function.prototype as unknown as Holder['value'],
  },
];

/** Native namespaces whose static functions are recognized by their actual identity and canonical key. */
const NAMESPACES: readonly unknown[] = [
  Array,
  String,
  Object,
  Number,
  Boolean,
  Function,
  Math,
  JSON,
  Reflect,
];

/** Every canonical place of a native function, including functions exposed at more than one key. */
const NATIVES: ReadonlyMap<unknown, readonly Place[]> = nativePlaces();

function nativePlaces(): ReadonlyMap<unknown, readonly Place[]> {
  const found = new Map<unknown, Place[]>();
  const holders: readonly Holder[] = [
    ...PROTOTYPES,
    ...NAMESPACES.map((namespace) => {
      return {
        accepts: (value: unknown) => value === namespace,
        value: namespace as Holder['value'],
      };
    }),
  ];
  for (const { value, accepts } of holders) {
    for (const key of Reflect.ownKeys(value)) {
      const held: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
      if (typeof held === 'function') {
        const places = found.get(held) ?? [];
        places.push({ accepts, key });
        found.set(held, places);
      }
    }
  }
  return found;
}

/**
 * A member captured once before arguments, refusing a known native function outside its canonical
 * place; while `checking`, the function and its arguments handed to `before` before it is called.
 */
export function methodOf<T, K extends keyof (MethodObject & NonNullable<T>)>(
  receiver: T,
  key: K,
  checking: boolean,
  before?: (called: unknown, given: readonly unknown[]) => void,
): OmitThisParameter<MethodValue<T, K>> {
  const value: unknown = receiver;
  if (value === null || value === undefined) {
    // A nullish property's read throws before its key is converted or its arguments are evaluated.
    return (receiver as MethodObject & NonNullable<T>)[key] as OmitThisParameter<MethodValue<T, K>>;
  }
  const named = Reflect.ownKeys({ [key]: true })[0] ?? '';
  const called = (receiver as MethodObject & NonNullable<T>)[named as K];
  const places = checking ? NATIVES.get(called) : undefined;
  if (places?.every((place) => place.key !== named || !place.accepts(receiver)) === true) {
    throw new TypeError(
      "A dynamic site's method call invokes a native function through another receiver or name: call the native method on its own value by its canonical name, or call an application function.",
    );
  }
  const invoke = (...given: readonly unknown[]): unknown => {
    const actual = called as (...args: readonly unknown[]) => unknown;
    if (checking) {
      before?.(actual, given);
    }
    return Reflect.apply(actual, receiver, given);
  };
  return invoke as OmitThisParameter<MethodValue<T, K>>;
}
