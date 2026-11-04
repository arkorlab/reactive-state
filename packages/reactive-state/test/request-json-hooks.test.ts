import { describe, expect, it } from 'vitest';

import { MAX_CARRIED_BYTES } from '../src/authority/json-size.ts';
import {
  argumentsOf,
  fieldOperationOf,
  operationCallOf,
  rootOf,
  viewRequestOf,
} from '../src/authority/requests.ts';

/** Validated transport JSON is copied without consulting inherited serialization hooks. */
describe('request normalization without inherited toJSON', () => {
  it.each([
    { name: 'root props', read: () => rootOf(root({ a: 1 })).props, expected: { a: 1 } },
    {
      name: 'view inputs',
      read: () => viewRequestOf({ subscription: 'frame', view: { part: { rows: { a: 1 } } } }).view,
      expected: { part: { rows: { a: 1 } } },
    },
    {
      name: 'captured values',
      read: () => fieldOperationOf(operation({ captures: { a: 1 } })).captures,
      expected: { a: 1 },
    },
    {
      name: 'operation JSON arguments',
      read: () => operationCallOf(call([{ json: { a: 1 } }])).args,
      expected: [{ json: { a: 1 } }],
    },
  ])('does not replace $name through an inherited hook', ({ read, expected }) => {
    const calls: unknown[] = [];
    const result = hooked<unknown>(
      Object.prototype,
      {
        value(this: unknown) {
          calls.push(this);
          return 'changed';
        },
      },
      read,
    );

    expect(result).toStrictEqual(expected);
    expect(calls).toStrictEqual([]);
  });

  it('does not execute a throwing inherited hook', () => {
    const calls: string[] = [];
    const result = hooked(
      Object.prototype,
      {
        value() {
          calls.push('toJSON');
          throw new Error('application toJSON');
        },
      },
      () => rootOf(root({ a: 1 })),
    );

    expect(result.props).toStrictEqual({ a: 1 });
    expect(calls).toStrictEqual([]);
  });

  it('does not even read an inherited toJSON accessor', () => {
    const calls: string[] = [];
    const result = hooked(
      Object.prototype,
      {
        get() {
          calls.push('get toJSON');
          throw new Error('application getter');
        },
      },
      () => rootOf(root({ a: 1 })),
    );

    expect(result.props).toStrictEqual({ a: 1 });
    expect(calls).toStrictEqual([]);
  });

  it('does not consult Array.prototype.toJSON for nested arrays', () => {
    const calls: string[] = [];
    const result = hooked(
      Array.prototype,
      {
        value() {
          calls.push('array toJSON');
          return 'changed';
        },
      },
      () => rootOf(root({ list: [1] })),
    );

    expect(result.props).toStrictEqual({ list: [1] });
    expect(calls).toStrictEqual([]);
  });

  it('does not invoke a hook that returns the original object either', () => {
    const calls: unknown[] = [];
    const result = hooked(
      Object.prototype,
      {
        value(this: unknown) {
          calls.push(this);
          return this;
        },
      },
      () => rootOf(root({ nested: { a: 1 } })),
    );

    expect(result.props).toStrictEqual({ nested: { a: 1 } });
    expect(calls).toStrictEqual([]);
  });

  it('keeps holes, omitted properties, signed zero and own proto keys normalized', () => {
    const list: unknown[] = [];
    list.length = 2;
    list[1] = -0;
    const props = Object.assign(Object.create(null) as Record<string, unknown>, {
      list,
      omitted: undefined,
    });
    Object.defineProperty(props, '__proto__', { enumerable: true, value: { safe: true } });

    const copied = rootOf(root(props)).props;

    expect(copied).toStrictEqual({ ['__proto__']: { safe: true }, list: [null, 0] });
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
    expect(Object.hasOwn(copied, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(copied['list'])).toBe(Array.prototype);
    expect(Object.is((copied['list'] as readonly number[])[1], -0)).toBe(false);
    expect(Object.hasOwn(list, 0)).toBe(false);
    expect(Object.is(list[1], -0)).toBe(true);
  });

  it('keeps invalid accessor props refused before evaluating them', () => {
    const calls: string[] = [];
    const props = {
      get a() {
        calls.push('get a');
        return 1;
      },
    };

    expect(() => rootOf(root(props))).toThrow('props as a JSON object');
    expect(calls).toStrictEqual([]);
  });

  it('keeps the byte budget checked before normalization', () => {
    const calls: string[] = [];

    expect(() => {
      return hooked(
        Object.prototype,
        {
          value() {
            calls.push('toJSON');
            return {};
          },
        },
        () => rootOf(root({ text: 'x'.repeat(MAX_CARRIED_BYTES) })),
      );
    }).toThrow('too large');
    expect(calls).toStrictEqual([]);
  });

  it('keeps primitive field zero normalized', () => {
    const result = fieldOperationOf(operation({ value: -0 }));

    expect(result.value).toBe(0);
    expect(Object.is(result.value, -0)).toBe(false);
  });

  it('keeps normal form arguments and their declared order', () => {
    const args = [
      {
        form: [
          ['name', 'first'],
          ['name', 'second'],
        ],
      },
    ];

    expect(operationCallOf(call(args)).args).toStrictEqual(args);
  });
});

/** A hook is restored before assertions or test reporting can serialize anything. */
function hooked<T>(prototype: WeakKey, descriptor: PropertyDescriptor, read: () => T): T {
  if (typeof prototype === 'symbol') {
    throw new TypeError('A serialization hook requires an object prototype.');
  }
  const previous = Object.getOwnPropertyDescriptor(prototype, 'toJSON');
  Object.defineProperty(prototype, 'toJSON', { configurable: true, ...descriptor });
  try {
    return read();
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(prototype, 'toJSON');
    } else {
      Object.defineProperty(prototype, 'toJSON', previous);
    }
  }
}

function root(props: unknown) {
  return { build: 'test', component: 'test/root', props };
}

function operation(extra: Readonly<Record<string, unknown>>) {
  return { binding: 'binding', operationId: 'op:1', updaterId: 'update', ...extra };
}

function call(args: unknown) {
  return { args, build: 'test', module: 'domain/actions', name: 'save', operationId: 'op:1' };
}

/** An operation envelope requires an own argument at every index, unlike nested carried JSON. */
describe('operation argument array own entries', () => {
  it.each([
    { name: 'only hole', args: missing([{ json: 1 }], 0) },
    { name: 'trailing hole', args: missing([{ json: 1 }, { json: 2 }], 1) },
    { name: 'middle hole', args: missing([{ json: 1 }, { json: 2 }, { json: 2 }], 1) },
  ])('refuses a $name before invoking an operation', ({ args }) => {
    expect(() => operationCallOf(call(args))).toThrow('Each argument is sent');
  });

  it.each(['inherited', 'own'])('refuses an %s argument accessor without reading it', (kind) => {
    const calls: string[] = [];
    class Arguments extends Array<unknown> {}
    const args = new Arguments(1);
    Object.defineProperty(kind === 'own' ? args : Arguments.prototype, '0', {
      enumerable: true,
      get() {
        calls.push('argument');
        return { json: 1 };
      },
    });

    expect(() => operationCallOf(call(args))).toThrow('Each argument is sent');
    expect(calls).toStrictEqual([]);
  });

  it.each([null, undefined])('keeps an explicit invalid argument refused: %s', (argument) => {
    expect(() => operationCallOf(call([argument]))).toThrow('Each argument is sent');
  });

  it('keeps empty argument arrays valid', () => {
    expect(operationCallOf(call([])).args).toStrictEqual([]);
  });

  it('keeps nested carried holes normalized inside a present JSON argument', () => {
    const nested: unknown[] = [];
    nested.length = 1;

    expect(operationCallOf(call([{ json: nested }, { json: null }])).args).toStrictEqual([
      { json: [null] },
      { json: null },
    ]);
  });

  it('keeps a nonenumerable own argument as native JSON does', () => {
    const args: unknown[] = [];
    Object.defineProperty(args, '0', { value: { json: 1 } });

    expect(operationCallOf(call(args)).args).toStrictEqual([{ json: 1 }]);
  });
});

/** A missing own slot keeps the original argument-array length. */
function missing(args: unknown[], index: number): unknown[] {
  Reflect.deleteProperty(args, String(index));
  return args;
}

/** Direct parser calls validate selected wrapper and form slots before application getters run. */
describe('operation argument wrapper data snapshots', () => {
  it('refuses a changing JSON wrapper getter before reading either payload', () => {
    const calls: string[] = [];
    const unchecked = {
      get value() {
        calls.push('unchecked payload');
        throw new Error('application unchecked payload');
      },
    };
    const wrapper = {
      get json() {
        calls.push('json wrapper');
        return calls.length === 1 ? 1 : unchecked;
      },
    };

    expect(() => operationCallOf(call([wrapper]))).toThrow(
      expect.objectContaining({ code: 'INVALID_OPERATION', status: 400 }),
    );
    expect(calls).toStrictEqual([]);
  });

  it('refuses a selected form wrapper getter without dispatching it', () => {
    const calls: string[] = [];
    const wrapper = {
      get form() {
        calls.push('form wrapper');
        throw new Error('application form wrapper');
      },
    };

    expect(() => operationCallOf(call([wrapper]))).toThrow(
      expect.objectContaining({ code: 'INVALID_OPERATION', status: 400 }),
    );
    expect(calls).toStrictEqual([]);
  });

  it.each([
    { name: 'only hole', entries: missing([['name', 'text']], 0) },
    {
      name: 'mixed hole',
      entries: missing(
        [
          ['name', 'first'],
          ['name', 'middle'],
          ['name', 'last'],
        ],
        1,
      ),
    },
  ])('refuses a form outer $name before materialization', ({ entries }) => {
    expect(() => operationCallOf(call([{ form: entries }]))).toThrow(
      expect.objectContaining({ code: 'INVALID_OPERATION', status: 400 }),
    );
  });

  it('refuses an outer form entry accessor without reading it', () => {
    const calls: string[] = [];
    const entries: unknown[] = [];
    Object.defineProperty(entries, '0', {
      get() {
        calls.push('form entry');
        return ['name', 'text'];
      },
    });

    expect(() => operationCallOf(call([{ form: entries }]))).toThrow(
      expect.objectContaining({ code: 'INVALID_OPERATION', status: 400 }),
    );
    expect(calls).toStrictEqual([]);
  });

  it('refuses an own tuple slot accessor without reading it', () => {
    const calls: string[] = [];
    const entry = ['name', 'text'];
    Object.defineProperty(entry, '0', {
      get() {
        calls.push('tuple name');
        return 'name';
      },
    });

    expect(() => operationCallOf(call([{ form: [entry] }]))).toThrow(
      expect.objectContaining({ code: 'INVALID_OPERATION', status: 400 }),
    );
    expect(calls).toStrictEqual([]);
  });

  it('refuses an inherited tuple slot without reading its getter', () => {
    const calls: string[] = [];
    class Entry extends Array<string> {}
    const entry = new Entry(2);
    entry[0] = 'name';
    Object.defineProperty(Entry.prototype, '1', {
      get() {
        calls.push('inherited tuple text');
        return 'text';
      },
    });

    expect(() => operationCallOf(call([{ form: [entry] }]))).toThrow(
      expect.objectContaining({ code: 'INVALID_OPERATION', status: 400 }),
    );
    expect(calls).toStrictEqual([]);
  });

  it('keeps dense duplicate form names in their original order', () => {
    const parsed = operationCallOf(
      call([
        {
          form: [
            ['name', 'first'],
            ['name', 'second'],
          ],
        },
      ]),
    );
    const [form] = argumentsOf(parsed.args);

    expect(form).toBeInstanceOf(FormData);
    expect([...(form as FormData)]).toStrictEqual([
      ['name', 'first'],
      ['name', 'second'],
    ]);
  });

  it('keeps an empty form materializable', () => {
    const parsed = operationCallOf(call([{ form: [] }]));
    const [form] = argumentsOf(parsed.args);

    expect(form).toBeInstanceOf(FormData);
    expect([...(form as FormData)]).toStrictEqual([]);
  });

  it('keeps nonenumerable own form and tuple indices', () => {
    const entry: unknown[] = [];
    Object.defineProperties(entry, {
      '0': { value: 'name' },
      '1': { value: 'text' },
    });
    const entries: unknown[] = [];
    Object.defineProperty(entries, '0', { value: entry });

    const parsed = operationCallOf(call([{ form: entries }]));
    const [form] = argumentsOf(parsed.args);

    expect(parsed.args).toStrictEqual([{ form: [['name', 'text']] }]);
    expect([...(form as FormData)]).toStrictEqual([['name', 'text']]);
  });

  it('keeps nested JSON holes carried beside a valid form', () => {
    const nested: unknown[] = [];
    nested.length = 2;
    nested[1] = -0;

    const parsed = operationCallOf(call([{ form: [] }, { json: nested }]));

    expect(parsed.args).toStrictEqual([{ form: [] }, { json: [null, 0] }]);
    expect(argumentsOf(parsed.args)[1]).toStrictEqual([null, 0]);
    expect(Object.hasOwn(nested, 0)).toBe(false);
    expect(Object.is(nested[1], -0)).toBe(true);
  });

  it('keeps the JSON-decoded null counterpart of a sparse form refused', () => {
    const sparse = missing([['name', 'text']], 0);
    const encoded = JSON.stringify(call([{ form: sparse }]));

    expect(encoded).toContain('"form":[null]');

    const decoded: unknown = JSON.parse(encoded);

    expect(() => operationCallOf(decoded)).toThrow(
      expect.objectContaining({ code: 'INVALID_OPERATION', status: 400 }),
    );
  });
});
