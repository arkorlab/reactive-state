import { describe, expect, it } from 'vitest';

import { refusalOf } from './fixtures/application.ts';
import { compilerApplications, stateFixture } from './support/compiler-applications.ts';

/** A discarded native operation is still evaluated by the authority for this state. */
const fixture = stateFixture('generator-consumption', 'GeneratorConsumption', 'ok');

/** Obtaining a generator leaves its body deferred; native collection consumption resumes it. */
describe('synchronous generator consumption', () => {
  const { apps, compile } = compilerApplications();

  it.each([
    "new Set({ *[Symbol.iterator]() { throw new Error('next'); } })",
    "new Map({ *[Symbol.iterator]() { throw new Error('next'); } })",
    "new WeakSet({ *[Symbol.iterator]() { throw new Error('next'); } })",
    "Array.from({ *[Symbol.iterator]() { yield first; throw new Error('next'); } })",
    "Object.fromEntries({ *[Symbol.iterator]() { yield ['key', first]; throw new Error('next'); } })",
  ])('refuses an escaping error while consuming the generator: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(refusalOf(compile(app)).reason).toContain('which no JSON holds');
  });

  it.each([
    "Iterator.from({ *[Symbol.iterator]() { throw new Error('deferred'); } })",
    "new Set({ *[Symbol.iterator]() { try { throw new Error('caught'); } catch {} } })",
    "new Set({ *[Symbol.iterator]() { try { throw new Error('overridden'); } finally { return; } } })",
    "new Set({ *[Symbol.iterator]() { yield first; return; throw new Error('unreachable'); } })",
    "(() => { try { new Set({ *[Symbol.iterator]() { throw new Error('caught'); } }); } catch {} return first; })()",
  ])('keeps acquired-only, handled and unreachable generator bodies: %s', async (expression) => {
    const app = await fixture(expression);
    apps.push(app);

    expect(compile(app).refusals).toStrictEqual([]);
  });
});
