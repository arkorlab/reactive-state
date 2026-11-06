import { functionsOf } from '../../src/authority/render.ts';
import { counted, method } from '../../src/authority/steps.ts';
import {
  type ComponentProgram,
  type Json,
  PROTOCOL_VERSION,
  type SiteInputs,
  type SiteItem,
} from '../../src/program.ts';
import { application, BUILD } from './program.ts';

export const ENTRY_COMPONENT = 'test/list-entry-fields';

/** An application-owned map may answer entry records of its own rather than invoke the callback. */
function generated(entry: unknown): (inputs: SiteInputs) => readonly SiteItem[] {
  const source = ['source'];
  Object.defineProperty(source, 'map', { value: () => [entry] });
  const functions = functionsOf({
    inputs: [],
    each: () =>
      counted(method(counted(source), 'map')((key) => ({ item: key, key, render: () => key }))),
  });
  if (functions.each === undefined) {
    throw new Error('The fixture defines a list.');
  }
  return functions.each;
}

/** The ordinary generated fields against which accessor variants are selected. */
function data(): SiteItem {
  return { item: { text: 'stored' }, key: 'stored', render: () => 'rendered' };
}

interface EntryFixture {
  readonly each: (inputs: SiteInputs) => readonly SiteItem[];
  readonly calls: readonly string[];
}

/** Getter and setter bodies must stay outside the authority's entry validation. */
export function fieldCases(): readonly {
  readonly name: string;
  readonly make: () => EntryFixture;
  readonly expected: readonly { readonly key: string; readonly item: Json }[] | undefined;
}[] {
  const invalid = (['key', 'item', 'render'] as const).flatMap((field) => {
    return [false, true].map((throws) => {
      return {
        name: `${field} getter, throwing=${String(throws)}`,
        expected: undefined,
        make(): EntryFixture {
          const calls: string[] = [];
          const entry = data();
          const original = entry[field];
          Object.defineProperty(entry, field, {
            get() {
              calls.push(field);
              if (throws) {
                throw new Error(`Application ${field} getter`);
              }
              return original;
            },
          });
          return { calls, each: generated(entry) };
        },
      };
    });
  });
  return [
    ...invalid,
    {
      name: 'ordinary own data fields',
      expected: [{ item: { text: 'stored' }, key: 'stored' }],
      make: () => ({ calls: [], each: generated(data()) }),
    },
    {
      name: 'own fields shadow inherited getters',
      expected: [{ item: { text: 'stored' }, key: 'stored' }],
      make(): EntryFixture {
        const calls: string[] = [];
        const prototype = Object.create(null) as Readonly<Record<string, unknown>>;
        for (const field of ['key', 'item', 'render']) {
          Object.defineProperty(prototype, field, {
            get() {
              calls.push(field);
              throw new Error('Own fields shadow this getter.');
            },
          });
        }
        const entry = data();
        Object.setPrototypeOf(entry, prototype);
        return { calls, each: generated(entry) };
      },
    },
    {
      name: 'unused accessor remains unread',
      expected: [{ item: { text: 'stored' }, key: 'stored' }],
      make(): EntryFixture {
        const calls: string[] = [];
        const entry = data();
        Object.defineProperty(entry, 'unused', {
          get() {
            calls.push('unused');
            throw new Error('Unused getter');
          },
        });
        return { calls, each: generated(entry) };
      },
    },
  ];
}

/** A first authority render must keep the invalid list local and preserve unrelated content. */
export function entryApplication(): {
  readonly options: typeof application;
  readonly calls: readonly string[];
} {
  const calls: string[] = [];
  const entry = data();
  Object.defineProperty(entry, 'key', {
    get() {
      calls.push('key');
      throw new Error('Initial list key getter');
    },
  });
  const program: ComponentProgram = {
    buildId: BUILD,
    component: ENTRY_COMPONENT,
    protocolVersion: PROTOCOL_VERSION,
    evaluate: (_props, $) => {
      return $.client({
        props: {},
        sites: { d0: { inputs: [], each: generated(entry) } },
        slots: { sibling: $.h('p', null, 'kept sibling') },
        states: {},
      });
    },
    updaters: {},
    writable: [],
  };
  return { calls, options: { ...application, programs: [...application.programs, program] } };
}
