import path from 'node:path';

import { pagesDirOf } from '../compiler/pages-routes.ts';

/** Where a compile reads: the application's root, its components' directory, its app directory. */
interface Layout {
  readonly projectDir: string;
  readonly srcDir: string;
  readonly appDir: string;
}

/** A directory the compile reads, by the name its files are digested under. */
interface Root {
  readonly name: string;
  readonly root: string;
}

/** Whether `file` is `directory` or something under it. */
export function isWithin(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * Whether the walk of `root` reads `directory`: it is `root` or under it, and no folder on the way
 * down to it is one the walk leaves out by its name (`unread`), as it leaves out `node_modules`.
 */
function isRead(root: string, directory: string, unread: ReadonlySet<string>): boolean {
  return (
    isWithin(root, directory) &&
    path
      .relative(root, directory)
      .split(path.sep)
      .every((name) => !unread.has(name))
  );
}

/**
 * The directories whose files a compile of `layout` reads that the digest of its inputs holds: the
 * application's root and, where the walk of the root does not read one, the components' directory,
 * the app's, and the Pages Router's beside the app's, whose routes the compile reads too
 * (`pagesDirOf`) — one that is not under the root, as a monorepo's shared `components` is not, or
 * one under a folder of it the walk leaves out by its name (`unread`): a file added to one is no
 * change of what the root's walk reads, and no file an earlier compile read. One the walk of
 * another reads is not listed, whichever of the two holds the other: its files are read once.
 */
export function inputRoots(layout: Layout, unread: ReadonlySet<string>): readonly Root[] {
  const outside = [
    { name: 'src', root: layout.srcDir },
    { name: 'app', root: layout.appDir },
    { name: 'pages', root: pagesDirOf(layout.appDir) },
  ].filter((directory) => !isRead(layout.projectDir, directory.root, unread));
  const isListed = (directory: Root, index: number): boolean => {
    return outside.every((other, at) => {
      // One directory given twice: the first of the two is the one listed.
      const isFirst = other.root === directory.root && at > index;
      return at === index || isFirst || !isRead(other.root, directory.root, unread);
    });
  };
  return [
    { name: 'project', root: layout.projectDir },
    ...outside.filter((directory, index) => isListed(directory, index)),
  ];
}
