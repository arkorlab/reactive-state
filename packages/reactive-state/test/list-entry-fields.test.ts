import { describe, expect, it } from 'vitest';

import { Engine } from '../src/authority/index.ts';
import { itemsWithin } from '../src/authority/items.ts';
import { clientOf, textOf } from './support/frames.ts';
import { ENTRY_COMPONENT, entryApplication, fieldCases } from './support/list-entry-fields.ts';
import { BUILD } from './support/program.ts';

describe('own data fields of generated list entries', () => {
  it.each(fieldCases())('checks $name without accessor evaluation', ({ expected, make }) => {
    const { calls, each } = make();
    const messages: string[] = [];

    const checked = itemsWithin('rows', each, {}, (message) => {
      messages.push(message);
    });

    expect(checked?.map(({ item, key }) => ({ item, key }))).toStrictEqual(expected);
    expect(calls).toStrictEqual([]);
    expect(messages.length > 0).toBe(expected === undefined);
  });

  it('contains an invalid authority-initial list without losing the sibling', async () => {
    const fixture = entryApplication();
    const engine = new Engine(fixture.options);
    try {
      const { sessionId } = await engine.login('alice');
      const first = await engine.render(sessionId, {
        build: BUILD,
        component: ENTRY_COMPONENT,
        props: {},
      });

      expect(clientOf(first.tree, ENTRY_COMPONENT).part.sites ?? {}).toStrictEqual({});
      expect(textOf(first.tree)).toContain('kept sibling');
      expect(fixture.calls).toStrictEqual([]);
    } finally {
      await engine.close();
    }
  });
});
