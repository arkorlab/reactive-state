import path from 'node:path';

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
function isWithin(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * The directories whose files a compile of `layout` reads that the digest of its inputs holds: the
 * application's root and, where either is not under it, the components' directory and the app's —
 * as a monorepo's shared `components` is not: a file added to one is no change of the root's, and no
 * file an earlier compile read. One inside another is listed once.
 */
export function inputRoots(layout: Layout): readonly Root[] {
  const outside = [
    { name: 'src', root: layout.srcDir },
    { name: 'app', root: layout.appDir },
  ].filter((directory) => !isWithin(layout.projectDir, directory.root));
  return [
    { name: 'project', root: layout.projectDir },
    ...outside.filter((directory, index) =>
      outside.slice(0, index).every((earlier) => !isWithin(earlier.root, directory.root)),
    ),
  ];
}
