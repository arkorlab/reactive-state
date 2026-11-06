import { describe, expect, it } from 'vitest';

import { itemsOf, itemsWithin } from '../../src/authority/items.ts';
import { type SiteItem, VIEW_LIMITS } from '../../src/program.ts';

/** List validation only reads the checked indices of an application's returned array. */
describe('list item array dispatch boundary', () => {
  it.each([
    ['filter', 'replacement'],
    ['filter', 'getter'],
    ['map', 'replacement'],
    ['map', 'getter'],
  ] as const)('ignores the returned array %s %s', (method, kind) => {
    const calls: string[] = [];
    class Returned extends Array<SiteItem> {}
    const override = () => {
      calls.push(method);
      return Array.from({ length: VIEW_LIMITS.items + 1 }, (_, index) => item(index));
    };
    Object.defineProperty(
      Returned.prototype,
      method,
      kind === 'getter'
        ? {
            get() {
              calls.push(method);
              throw new Error('application array getter');
            },
          }
        : { value: override },
    );
    // A generated native map retains the application's Array species.
    const answered: unknown = Reflect.apply(Array.prototype.map, new Returned(item(0)), [
      (entry: SiteItem) => entry,
    ]);

    const checked = itemsOf('rows', () => answered as readonly SiteItem[], {}, Error);

    expect(checked.map((entry) => entry.key)).toStrictEqual(['0']);
    expect(calls).toStrictEqual([]);
  });

  it('checks the original length before an override could hide excess entries', () => {
    const calls: string[] = [];
    const answered = Array.from({ length: VIEW_LIMITS.items + 1 }, (_, index) => item(index));
    Object.defineProperty(answered, 'filter', {
      value() {
        calls.push('filter');
        return [];
      },
    });

    expect(itemsWithin('rows', () => answered, {})).toBeUndefined();
    expect(calls).toStrictEqual([]);
  });

  it('keeps holes and undefined entries empty', () => {
    const answered: (SiteItem | undefined)[] = [];
    answered.length = 2;
    answered[1] = undefined;
    answered.push(item(0));

    const checked = itemsOf('rows', () => answered as readonly SiteItem[], {}, Error);

    expect(checked.map((entry) => entry.key)).toStrictEqual(['0']);
  });

  it('keeps the sixteen-item boundary, JSON snapshots and guarded renders', () => {
    const payload = { text: 'first' };
    const answered = Array.from({ length: VIEW_LIMITS.items }, (_, index) => {
      const entry = item(index);
      return { ...entry, item: payload };
    });

    const checked = itemsOf('rows', () => answered, {}, Error);
    payload.text = 'changed';

    expect(checked).toHaveLength(VIEW_LIMITS.items);
    expect(checked[0]?.item).toStrictEqual({ text: 'first' });
    expect(Object.isFrozen(checked[0]?.item)).toBe(true);
    expect(checked[0]?.render()).toBe('rendered');
  });

  it.each([[item(0), item(0)], [{ ...item(0), item: NaN }]])(
    'keeps invalid keys and JSON values refused',
    (...answered) => {
      expect(itemsWithin('rows', () => answered, {})).toBeUndefined();
    },
  );
});

/** Each source entry carries its ordinary key, JSON value and deferred rendering. */
function item(key: number): SiteItem {
  return { item: { key }, key, render: () => 'rendered' };
}
