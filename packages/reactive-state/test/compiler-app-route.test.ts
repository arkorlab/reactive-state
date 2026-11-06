import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { routeCollisions } from '../src/compiler/app-route.ts';

/**
 * The application's routes the compile refuses beside its own (`api/reactive-state/[...path]`),
 * which serves every path under `/api/reactive-state/` and which Next.js matches first there: one
 * written under it, and one whose dynamic segment or catch-all may be served there where it writes
 * a segment of that path at its place.
 */

const dirs: string[] = [];

/** An application of `files`, each a page or a route handler of nothing. */
function application(files: readonly string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'reactive-state-app-route-'));
  dirs.push(dir);
  for (const file of files) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), 'export default function Page() {\n  return null;\n}\n');
  }
  return dir;
}

/** Each file of `dir`'s the compile refuses, and how its reason opens. */
function refused(dir: string): readonly (readonly [string, string])[] {
  return routeCollisions(path.join(dir, 'app'), path.join(dir, '.reactive')).map(
    ({ file, reason }) => [path.relative(dir, file), reason.slice(0, reason.indexOf(' — '))],
  );
}

const WRITTEN =
  "A route of the application's is served under `/api/reactive-state/`, every path of which the compile's route (`api/reactive-state/[...path]/route.ts`) serves: one would answer in the other's place. Move it from under `/api/reactive-state/`.";
const MAY_BE = "A route of the application's may be served at a path under `/api/reactive-state/`";

/** By the file each names. */
function byFile(one: readonly [string, string], other: readonly [string, string]): number {
  return one[0].localeCompare(other[0]);
}

describe('a route of the application’s beside the compile’s', () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('is refused where a dynamic segment or a catch-all of it may be served under `/api/reactive-state/`, a segment of that path written at its place', () => {
    const dir = application([
      'app/api/[namespace]/custom/route.ts',
      'app/api/[...rest]/route.ts',
      'app/api/[ns]/[[...rest]]/page.tsx',
      'app/(site)/[x]/reactive-state/feed/page.tsx',
      'pages/api/[namespace]/custom.ts',
      'pages/[x]/reactive-state/feed.tsx',
    ]);

    const expected: readonly (readonly [string, string])[] = [
      ['app/(site)/[x]/reactive-state/feed/page.tsx', MAY_BE],
      ['app/api/[...rest]/route.ts', MAY_BE],
      ['app/api/[namespace]/custom/route.ts', MAY_BE],
      ['app/api/[ns]/[[...rest]]/page.tsx', MAY_BE],
      ['pages/[x]/reactive-state/feed.tsx', MAY_BE],
      ['pages/api/[namespace]/custom.ts', MAY_BE],
    ];

    expect(refused(dir).toSorted(byFile)).toStrictEqual(expected.toSorted(byFile));
  });

  it('is refused as served under `/api/reactive-state/` where it writes that path whole, of either router', () => {
    const dir = application([
      'app/api/reactive-state/feed/route.ts',
      'pages/api/reactive-state/[...slug].ts',
    ]);

    expect(
      routeCollisions(path.join(dir, 'app'), path.join(dir, '.reactive')).map(
        ({ reason }) => reason,
      ),
    ).toStrictEqual([WRITTEN, WRITTEN]);
  });

  it('is let be where it writes none of that path’s segments, or is served at no path under it', () => {
    const dir = application([
      'app/[section]/[id]/[part]/page.tsx',
      'app/[...slug]/page.tsx',
      'app/api/[namespace]/route.ts',
      'app/api/trpc/[trpc]/route.ts',
      'app/api/reactive/[x]/route.ts',
      'pages/api/[namespace]/index.ts',
      'pages/api/reactive-state/index.ts',
      'pages/[...slug].tsx',
    ]);

    expect(refused(dir)).toStrictEqual([]);
  });
});
