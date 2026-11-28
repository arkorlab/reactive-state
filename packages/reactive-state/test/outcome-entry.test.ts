import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import * as entry from '../src/outcome.ts';

/**
 * The light entry an error-tracking hook imports (`./outcome`): it reads an operation's error and
 * pulls in nothing else, so a bundle that holds the hook holds no React and no authority, and it
 * answers the readers alone, not the digest's builder.
 */

const refused = Object.assign(new Error('hidden'), {
  digest: 'REACTIVE_STATE_OPERATION;refused;SOME_CODE',
});

/** The text of a module of the package's, by its path from `src`. */
async function sourceOf(file: string): Promise<string> {
  return readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
}

describe('the outcome entry', () => {
  it('reads the code and the outcome of an operation error', () => {
    expect(entry.operationRefusal(refused)).toStrictEqual({ code: 'SOME_CODE' });
    expect(entry.operationOutcome(refused)).toBe('refused');
    expect(entry.operationRefusal(new Error('plain'))).toBeUndefined();
  });

  it('answers the two readers alone', () => {
    expect(new Set(Object.keys(entry))).toStrictEqual(
      new Set(['operationOutcome', 'operationRefusal']),
    );
  });

  it('is exported as ./outcome', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { readonly exports: Readonly<Record<string, unknown>> };

    expect(manifest.exports['./outcome']).toBe('./src/outcome.ts');
  });

  it('imports the module of no imports alone', async () => {
    const own = await sourceOf('outcome.ts');
    const reader = await sourceOf('runtime/outcome.ts');

    expect(own.split(" from '").length - 1).toBe(1);
    expect(own).toContain(" from './runtime/outcome.ts';");
    expect(reader).not.toContain(" from '");
    expect(reader).not.toContain('import(');
    expect(reader).not.toContain('require(');
  });
});
