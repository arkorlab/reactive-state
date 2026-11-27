import { pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { openedWith } from './support/drizzle.ts';

const tasks = pgTable('tasks', { id: text().primaryKey(), title: text() });
const schema = { tasks };
const DDL = `CREATE TABLE tasks (id text PRIMARY KEY, title text);`;

/** A namespace an extension puts on a connection. */
const extension = { label: 'fixed' };

/**
 * A member a connection fixed and may not write — `Object.defineProperty(pg, 'extension', { value })`
 * leaves it neither configurable nor writable — is answered as it stands by name, as it is by its
 * descriptor: a proxy of the connection may answer nothing else of it, and throws where it does.
 */
describe(
  'a followed PGlite client of a connection with a fixed member',
  { timeout: 20_000 },
  () => {
    it('answers a namespace the connection fixed and may not write by its name as it stands', async () => {
      const setup = await openedWith(schema, DDL);
      const original = Object.defineProperty(setup.pg, 'extension', { value: extension });
      const client = setup.follow.client(original);

      expect(Reflect.get(client, 'extension')).toBe(extension);
    });

    it('answers a fixed namespace by its name as by its descriptor', async () => {
      const setup = await openedWith(schema, DDL);
      const original = Object.defineProperty(setup.pg, 'extension', {
        configurable: false,
        enumerable: true,
        value: extension,
        writable: false,
      });
      const client = setup.follow.client(original);

      expect(Reflect.get(client, 'extension')).toBe(
        Object.getOwnPropertyDescriptor(client, 'extension')?.value,
      );
    });

    it('keeps guarding a namespace the connection may write, though it cannot configure it', async () => {
      const setup = await openedWith(schema, DDL);
      const original = Object.defineProperty(setup.pg, 'extension', {
        configurable: false,
        value: extension,
        writable: true,
      });
      const client = setup.follow.client(original);

      // A facade of the namespace, which refuses its methods in a render; its members read through.
      expect(Reflect.get(client, 'extension')).not.toBe(extension);
      expect((Reflect.get(client, 'extension') as typeof extension).label).toBe('fixed');
    });
  },
);
