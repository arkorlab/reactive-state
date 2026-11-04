import { VIEW_LIMITS } from '../../src/program.ts';

const PAD_START: unknown = Reflect.get(String.prototype, 'padStart');

/** Native collection slots whose cardinality and nested values spend the same site budget. */
export function oversizedCollections(): readonly {
  readonly name: string;
  readonly make: () => unknown;
}[] {
  return [
    { name: 'Map cardinality', make: oversizedMap },
    { name: 'Set cardinality', make: oversizedSet },
    { name: 'Map text key', make: () => new Map([['x'.repeat(VIEW_LIMITS.steps), 0]]) },
    { name: 'Map text value', make: () => new Map([[0, 'x'.repeat(VIEW_LIMITS.steps)]]) },
    { name: 'Set text value', make: () => new Set(['x'.repeat(VIEW_LIMITS.steps)]) },
    {
      name: 'nested collection value',
      make: () => new Map([[0, new Set([{ text: 'x'.repeat(VIEW_LIMITS.steps) }])]]),
    },
    {
      name: 'repeated Map value',
      make() {
        const shared = { text: 'x'.repeat(Math.floor(VIEW_LIMITS.steps / 2)) };
        return new Map([
          [0, shared],
          [1, shared],
        ]);
      },
    },
  ];
}

/** Slot values retain the existing integer and native-function restrictions. */
export function unsafeCollections(): readonly {
  readonly name: string;
  readonly make: () => unknown;
}[] {
  return [
    { name: 'Map integer key', make: () => new Map([[1n, 0]]) },
    { name: 'Map integer value', make: () => new Map([[0, 1n]]) },
    { name: 'Set integer value', make: () => new Set([1n]) },
    { name: 'Map native method value', make: () => new Map([[0, PAD_START]]) },
  ];
}

/** Internal keys and values must reach the Proxy boundary before application traps run. */
export function proxyCollections(): readonly {
  readonly name: string;
  readonly make: () => { readonly value: unknown; readonly calls: readonly string[] };
}[] {
  return (['Map key', 'Map value', 'Set value'] as const).map((name) => {
    return {
      name,
      make() {
        const calls: string[] = [];
        const proxy = new Proxy(
          {},
          {
            ownKeys(): never {
              calls.push('ownKeys');
              throw new Error('application trap');
            },
            getOwnPropertyDescriptor(): never {
              calls.push('descriptor');
              throw new Error('application trap');
            },
            getPrototypeOf(): never {
              calls.push('prototype');
              throw new Error('application trap');
            },
          },
        );
        let value: unknown = new Set([proxy]);
        if (name === 'Map key') {
          value = new Map([[proxy, 0]]);
        } else if (name === 'Map value') {
          value = new Map([[0, proxy]]);
        }
        return { value, calls };
      },
    };
  });
}

/** Cycles are counted once along the current traversal path, rather than expanded indefinitely. */
export function cyclicCollections(): readonly {
  readonly name: string;
  readonly make: () => unknown;
}[] {
  return [
    {
      name: 'Map cycle',
      make() {
        const value = new Map<string, unknown>();
        value.set('self', value);
        return value;
      },
    },
    {
      name: 'Set cycle',
      make() {
        const value = new Set<unknown>();
        value.add(value);
        return value;
      },
    },
    {
      name: 'Map and Set cycle',
      make() {
        const value = new Map<string, unknown>();
        const inner = new Set([value]);
        value.set('inner', inner);
        return value;
      },
    },
  ];
}

/** Size is charged before an application iterator can consume or hide the original slots. */
export function oversizedMap(): Map<number, number> {
  const value = new Map<number, number>();
  for (let index = 0; index <= VIEW_LIMITS.steps; index += 1) {
    value.set(index, 0);
  }
  return value;
}

function oversizedSet(): Set<number> {
  const value = new Set<number>();
  for (let index = 0; index <= VIEW_LIMITS.steps; index += 1) {
    value.add(index);
  }
  return value;
}
