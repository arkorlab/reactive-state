import { describe, expect, it } from 'vitest';

import { boundD1 } from '../src/sql/sqlite/bound-d1.ts';

/** Which D1 of a Worker's bindings an application's `reactiveDb` reads. */

/** What a stub's method answers: nothing, of no call made. */
function answered(): Promise<void> {
  return Promise.resolve();
}

/** A service's binding, as workerd's stub of one answers any method of its name. */
const service = new Proxy({}, { get: () => answered });

/** A binding of D1's shape, of no statement run. */
const d1 = () => {
  return {
    batch: () => Promise.resolve([]),
    exec: () => Promise.resolve(),
    prepare: () => ({}),
  };
};
const kv = { get: () => Promise.resolve(null), put: () => Promise.resolve() };

describe('the D1 a Worker reads', () => {
  it("is the one bound, whatever a host lists beside: the object reads no host's list of resources", () => {
    const db = d1();
    const env = {
      HOST_RESOURCES: JSON.stringify([{ name: 'OTHER', type: 'd1' }]),
      DB: db,
      KV: kv,
    };

    expect(boundD1(env)).toBe(db);
  });

  it('is the one bound, of its bindings of other kinds too', () => {
    const db = d1();

    expect(boundD1({ DB: db, KV: kv, NAME: 'text' })).toBe(db);
  });

  it('is the one bound, of a Worker bound services too, whose stubs answer any method', () => {
    const db = d1();

    expect(boundD1({ DB: db, SERVICE: service })).toBe(db);
  });

  it('is the one named, whatever its methods answer, as an application names its own', () => {
    expect(boundD1({ DB: service, KV: kv }, 'DB')).toBe(service);
  });

  it('is the one named, of several', () => {
    const named = d1();

    expect(boundD1({ A: d1(), B: named }, 'B')).toBe(named);
  });

  it('refuses to choose of several, and says how', () => {
    expect(() => boundD1({ A: d1(), B: d1() })).toThrow("reactiveDb(schema, { binding: 'A' })");
  });

  it('says so of none, and of a name of no D1', () => {
    expect(() => boundD1({ KV: kv })).toThrow('No D1 database is bound');
    expect(() => boundD1({ KV: kv }, 'KV')).toThrow('KV is no D1 database');
  });
});
