import { functionsOf } from '../../src/authority/render.ts';
import { counted, method } from '../../src/authority/steps.ts';
import { type SiteInputs, type SiteItem, VIEW_LIMITS } from '../../src/program.ts';

interface ResultCase {
  readonly name: string;
  readonly make: () => {
    readonly calls: readonly string[];
    readonly each: (inputs: SiteInputs) => readonly SiteItem[];
  };
  readonly keys: readonly string[] | undefined;
}

/** The same generated native map and authority step scope that produce a list's returned array. */
function generated(source: readonly string[]): (inputs: SiteInputs) => readonly SiteItem[] {
  const functions = functionsOf({
    inputs: [],
    each: () => counted(method(counted(source), 'map')((key) => counted(item(key)))),
  });
  if (functions.each === undefined) {
    throw new Error('The fixture defines a list.');
  }
  return functions.each;
}

/** A native map of holes creates the application's species without writing those result indices. */
function species(
  inherited: PropertyDescriptor | undefined,
  own?: PropertyDescriptor,
  length = 1,
): readonly string[] {
  class Returned extends Array<SiteItem> {
    constructor(size: number) {
      super(size);
      if (own !== undefined) {
        Object.defineProperty(this, '0', own);
      }
    }
  }
  if (inherited !== undefined) {
    Object.defineProperty(Returned.prototype, '0', inherited);
  }
  const source: string[] = [];
  source.length = length;
  Object.defineProperty(source, 'constructor', { value: { [Symbol.species]: Returned } });
  return source;
}

/** A generated list entry with an ordinary JSON item and deferred rendering. */
function item(key: string): SiteItem {
  return { item: { key }, key, render: () => 'rendered' };
}

/** Identical own-entry boundary witnesses for Node and actual workerd. */
export function listResultEntries(): readonly ResultCase[] {
  return [
    {
      name: 'ignores a throwing inherited indexed getter',
      keys: [],
      make() {
        const calls: string[] = [];
        const source = species({
          get() {
            calls.push('inherited getter');
            throw new Error('A result hole must not read its prototype.');
          },
        });
        return { calls, each: generated(source) };
      },
    },
    {
      name: 'ignores an inherited getter that manufactures an unmeasured item',
      keys: [],
      make() {
        const calls: string[] = [];
        const source = species({
          get() {
            calls.push('unmeasured getter');
            return { ...item('phantom'), item: counted('x'.repeat(VIEW_LIMITS.steps + 1)) };
          },
        });
        return { calls, each: generated(source) };
      },
    },
    {
      name: 'ignores inherited data at a missing result index',
      keys: [],
      make: () => ({ calls: [], each: generated(species({ value: item('phantom') })) }),
    },
    {
      name: 'refuses an own indexed getter without invoking it',
      keys: undefined,
      make() {
        const calls: string[] = [];
        const source = species(undefined, {
          get() {
            calls.push('own getter');
            return item('phantom');
          },
        });
        return { calls, each: generated(source) };
      },
    },
    {
      name: 'refuses an own setter-only result index',
      keys: undefined,
      make() {
        const calls: string[] = [];
        const source = species(undefined, {
          set(value: unknown) {
            calls.push('own setter', typeof value);
          },
        });
        return { calls, each: generated(source) };
      },
    },
    {
      name: 'keeps ordinary generated map data entries',
      keys: ['valid'],
      make: () => ({ calls: [], each: generated(['valid']) }),
    },
    {
      name: 'keeps ordinary native map holes empty',
      keys: [],
      make() {
        const source: string[] = [];
        source.length = 2;
        return { calls: [], each: generated(source) };
      },
    },
    {
      name: 'keeps own data ahead of an inherited indexed getter',
      keys: ['valid'],
      make() {
        const calls: string[] = [];
        const source = species(
          {
            get() {
              calls.push('shadowed getter');
              throw new Error('Own data shadows this getter.');
            },
          },
          { value: item('valid') },
        );
        return { calls, each: generated(source) };
      },
    },
    {
      name: 'keeps own undefined ahead of an inherited indexed getter',
      keys: [],
      make() {
        const calls: string[] = [];
        const source = species(
          {
            get() {
              calls.push('shadowed getter');
              throw new Error('Own undefined shadows this getter.');
            },
          },
          { value: undefined },
        );
        return { calls, each: generated(source) };
      },
    },
    {
      name: 'checks oversized sparse length before reading result entries',
      keys: undefined,
      make() {
        const calls: string[] = [];
        const source = species(
          {
            get() {
              calls.push('oversized getter');
              throw new Error('Length is refused before an entry is read.');
            },
          },
          undefined,
          VIEW_LIMITS.items + 1,
        );
        return { calls, each: generated(source) };
      },
    },
  ];
}
