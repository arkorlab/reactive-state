import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from '../src/program.ts';
import { FRAMEWORK_CODES, isApplicationCode } from '../src/refusal-codes.ts';
import { operationDigest, operationRefusal } from '../src/runtime/outcome.ts';
import { refuse } from '../src/server/index.ts';
import { opened as openedEngine } from './support/todo-app/engine.ts';
import { application, BUILD } from './support/todo-app/programs.ts';

/**
 * An application's own refusal of a server operation, `refuse(code, message?)`: answered 422 with
 * its code, kept for a resend as the authority's own refusals are, and read on the page by
 * `operationRefusal`. No code of the authority's may name one.
 */

const MODULE = 'test/refusing';
/** The constants of the sources named as they read that name no refusal: the environment's. */
const NOT_CODES: ReadonlySet<string> = new Set(['NODE_ENV']);
/** Where the package's sources are, which every code the authority answers is written in. */
const SOURCES = path.join(import.meta.dirname, '../src');

/** What `promise` was rejected with; a test fails when it was not. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('It was not rejected.');
}

/** An authority of the test application and of `operations`, and a session of Alice's. */
async function opened(operations: Readonly<Record<string, unknown>>) {
  const engine = await openedEngine({
    operations: { ...application.operations, [MODULE]: operations },
  });
  const { sessionId } = await engine.login('alice');
  const operate = async (name: string, operationId = crypto.randomUUID()) =>
    engine.operate(sessionId, { args: [], build: BUILD, module: MODULE, name, operationId });
  return { operate };
}

/** The TypeScript files under `dir`, each path whole. */
async function sourcesUnder(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** The helpers of the package's sources whose first parameter is a refusal's code: `invalid`. */
function codeHelpersIn(texts: readonly string[]): ReadonlySet<string> {
  const helpers = new Set<string>();
  for (const text of texts) {
    const declared = text.matchAll(/function (\w+)\(code: string/gu);
    for (const [, name] of declared) if (name !== undefined && name !== 'refuse') helpers.add(name);
  }
  return helpers;
}

/**
 * The codes `text` names a refusal by: a `code:` property, `refusal`'s and `refused`'s, a constant
 * named as it reads (`export const BUILD_MISMATCH = 'BUILD_MISMATCH'`), and a helper's.
 */
function codesIn(text: string, helpers: ReadonlySet<string>): readonly string[] {
  const properties = [...text.matchAll(/code:\s*'([A-Z][\dA-Z_]+)'/gu)].map(([, code]) => code);
  const refusals = [...text.matchAll(/refus(?:al|ed)\(\s*\w+,\s*'([A-Z][\dA-Z_]+)'/gu)].map(
    ([, code]) => code,
  );
  const constants = [...text.matchAll(/const ([A-Z][\dA-Z_]+) = '([A-Z][\dA-Z_]+)'/gu)]
    .filter((match) => match[1] === match[2] && !NOT_CODES.has(match[1] ?? ''))
    .map((match) => match[1]);
  const helped = [...text.matchAll(/\b(\w+)\(\s*'([A-Z][\dA-Z_]+)'/gu)]
    .filter(([, name]) => name !== undefined && helpers.has(name))
    .map((match) => match[2]);
  return [...properties, ...refusals, ...constants, ...helped].filter((code) => code !== undefined);
}

/** Every code the package's sources answer a refusal with, as its literal names it. */
async function answeredCodes(): Promise<ReadonlySet<string>> {
  const files = await sourcesUnder(SOURCES);
  const texts = await Promise.all(files.map(async (file) => readFile(file, 'utf8')));
  const helpers = codeHelpersIn(texts);
  return new Set(texts.flatMap((text) => codesIn(text, helpers)));
}

describe('an application’s own refusal of a server operation', () => {
  it('answers 422 with the code and the message, the same on a resend, and runs the operation once', async () => {
    let runs = 0;
    const { operate } = await opened({
      join: (): never => {
        runs += 1;
        refuse('ALREADY_MEMBER', 'Already a member of the team.');
      },
    });

    const first = await rejection(operate('join', 'op-join'));
    const again = await rejection(operate('join', 'op-join'));

    expect(first).toMatchObject({
      code: 'ALREADY_MEMBER',
      message: 'Already a member of the team.',
      status: 422,
    });
    expect(again).toMatchObject({ code: 'ALREADY_MEMBER', status: 422 });
    expect(runs).toBe(1);
  });

  it('names its code in its message where it is given none', async () => {
    const { operate } = await opened({
      full: (): never => refuse('NO_SEATS'),
    });

    await expect(rejection(operate('full'))).resolves.toMatchObject({
      code: 'NO_SEATS',
      message: 'Refused: NO_SEATS.',
    });
  });

  it.each(['lower', '1STARTS_WITH_A_DIGIT', 'HAS-A-DASH', 'HAS A SPACE', '', 'A'.repeat(65)])(
    'refuses a code of another shape: %j',
    (code) => {
      expect(() => refuse(code)).toThrow(TypeError);
    },
  );

  it.each(['A', 'A'.repeat(64), 'TEAM_FULL_2'])('takes a code of the shape: %s', (code) => {
    expect(() => refuse(code)).toThrow(expect.objectContaining({ code, status: 422 }));
  });

  it.each([
    'FORBIDDEN',
    'UNAUTHENTICATED',
    'BUILD_MISMATCH',
    'NOT_FOUND',
    'INTERNAL_ERROR',
    'OPERATION_REJECTED',
    'OPERATION_OF_ITS_OWN',
    'AUTHORITY_UNAVAILABLE',
  ])('refuses the authority’s code %s', (code) => {
    expect(() => refuse(code)).toThrow("the authority's own code");
  });

  it('refuses every code the package answers a refusal with', async () => {
    const codes = await answeredCodes();
    const taken = [...codes].filter((code) => {
      try {
        refuse(code);
      } catch (error) {
        return !(error instanceof TypeError);
      }
      return true;
    });

    expect(codes.size).toBeGreaterThan(20);
    expect(codes).toContain('INVALID_SITE');
    expect(taken).toStrictEqual([]);
  });

  it('reserves no code the package does not answer, which a scan of its sources finds each of', async () => {
    const codes = await answeredCodes();

    expect([...FRAMEWORK_CODES].filter((code) => !codes.has(code))).toStrictEqual([]);
  });

  it('reads no code the package answers a refusal with as the application’s own, as a page reads one', async () => {
    const codes = await answeredCodes();

    expect([...codes].filter((code) => isApplicationCode(code))).toStrictEqual([]);
  });

  it.each([
    'ALREADY_MEMBER',
    'NOT_IN_TEAM',
    'A',
    'FORBIDDEN',
    'UNAUTHENTICATED',
    'BUILD_MISMATCH',
    'OPERATION_REJECTED',
    'AUTHORITY_ERROR',
    'lower',
    'FORBIDDEN;team',
    '',
  ])('reads %j as the application’s own where refuse takes it alone', (code) => {
    let taken = false;
    try {
      refuse(code);
    } catch (error) {
      taken = !(error instanceof TypeError);
    }

    expect(isApplicationCode(code)).toBe(taken);
  });

  it('refuses a render with the code, as the authority’s other refusals do', async () => {
    const engine = await openedEngine({
      programs: [
        ...application.programs,
        {
          buildId: BUILD,
          component: 'components/refusing',
          evaluate: (): never => refuse('NOT_YOURS'),
          protocolVersion: PROTOCOL_VERSION,
          updaters: {},
          writable: [],
        },
      ],
    });
    const { sessionId } = await engine.login('alice');
    const root = { build: BUILD, component: 'components/refusing', props: {} };

    await expect(rejection(engine.render(sessionId, root))).resolves.toMatchObject({
      code: 'NOT_YOURS',
      message: 'Refused: NOT_YOURS.',
      status: 422,
    });
  });

  it('answers an operation that refuses a code it was not given as rejected, with why', async () => {
    const { operate } = await opened({
      misnamed: (): never => refuse('FORBIDDEN'),
    });

    await expect(rejection(operate('misnamed'))).resolves.toMatchObject({
      code: 'OPERATION_REJECTED',
      message: expect.stringContaining('the authority'),
      status: 422,
    });
  });
});

describe('what a page reads of a refused operation', () => {
  it.each([
    ['refused', 'ALREADY_MEMBER', { code: 'ALREADY_MEMBER' }],
    ['refused', 'UNAUTHENTICATED', { code: 'UNAUTHENTICATED' }],
    ['refused', 'FORBIDDEN;team', { code: 'FORBIDDEN;team' }],
    ['refused', 'already-member', { code: 'already-member' }],
    ['unknown', 'AUTHORITY_UNAVAILABLE', undefined],
  ] as const)('reads an operation %s of %s', (outcome, code, read) => {
    expect(operationRefusal({ digest: operationDigest(outcome, code) })).toStrictEqual(read);
  });

  it.each([
    undefined,
    null,
    new Error('A render faulted.'),
    { digest: 'NEXT_REDIRECT;replace;/x' },
    { digest: 'REACTIVE_STATE_OPERATION;refused;' },
    { digest: 42 },
  ])('reads nothing of %j', (error) => {
    expect(operationRefusal(error)).toBeUndefined();
  });
});
