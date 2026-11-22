import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { inputRoots } from '../src/next/input-roots.ts';

/**
 * The directories the digest of a compile's inputs walks (`inputRoots`): the application's root,
 * and the components' directory and the app's wherever the walk of the root does not read them —
 * outside it, or under a folder of it the walk leaves out by its name, as it leaves out
 * `node_modules`. A file added to a directory no walk reads is in no digest, and the compile after
 * it is skipped.
 */

const ROOT = path.resolve('/repository/application');
/** The folders a walk leaves out by name, as the build's compile names them. */
const UNREAD: ReadonlySet<string> = new Set(['.state', 'node_modules']);

/** The directories read for an application whose components are in `src` and pages in `app`. */
function read(src: string, app: string): readonly string[] {
  const roots = inputRoots(
    { appDir: path.resolve(ROOT, app), projectDir: ROOT, srcDir: path.resolve(ROOT, src) },
    UNREAD,
  );
  return roots.map(({ name, root }) =>
    [name, path.relative(ROOT, root).split(path.sep).join('/')].join(':'),
  );
}

describe('the directories the digest of a compile’s inputs walks', () => {
  it.each([
    { app: 'src/app', id: 'both-under-the-root', roots: ['project:'], src: 'src' },
    {
      app: 'app',
      id: 'components-outside-the-root',
      roots: ['project:', 'src:../shared/components'],
      src: '../shared/components',
    },
    {
      app: 'app',
      id: 'components-under-an-unread-folder',
      roots: ['project:', 'src:.state/components'],
      src: '.state/components',
    },
    {
      app: 'node_modules/site/app',
      id: 'pages-under-an-unread-folder',
      roots: ['project:', 'app:node_modules/site/app'],
      src: 'src',
    },
    {
      app: '.state/site/app',
      id: 'pages-in-the-components-under-an-unread-folder',
      roots: ['project:', 'src:.state/site'],
      src: '.state/site',
    },
    {
      app: '../shared/node_modules/site/app',
      id: 'pages-under-an-unread-folder-of-the-components',
      roots: ['project:', 'src:../shared', 'app:../shared/node_modules/site/app'],
      src: '../shared',
    },
  ])('$id', ({ app, roots, src }) => {
    expect(read(src, app)).toStrictEqual(roots);
  });
});
