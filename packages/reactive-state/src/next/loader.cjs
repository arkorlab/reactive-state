'use strict';

// Turbopack's loader for `*.reactive.tsx` (`withReactiveState`): an import of a component's source
// gets the root entry the compile wrote for it in its place. `<root>/<src>/<id>.reactive.tsx`
// becomes a re-export of `<root>/<out>/<id>.root.tsx`, by its path from the source's directory. The
// source is not read: what it compiles to is the compile's, which wrote the entry.
//
// Plain CommonJS, which Turbopack's loader runner requires as it is, in Node.

const path = process.getBuiltinModule('node:path');

const SUFFIX = '.reactive.tsx';

// The module that stands in for `resourcePath`, given the options `withReactiveState` set.
function rewrite(resourcePath, { out, root, src }) {
  const file = path.resolve(root, resourcePath);
  const sources = path.resolve(root, src);
  const relative = path.relative(sources, file);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    !relative.endsWith(SUFFIX)
  ) {
    throw new Error(
      `${file} is not a component under ${sources}, where the compile reads them: move it there, or give withReactiveState the src it is under.`,
    );
  }
  const id = relative.slice(0, -SUFFIX.length).split(path.sep).join('/');
  const entry = path.resolve(root, out, `${id}.root.tsx`);
  return `export { default } from ${JSON.stringify(specifierOf(path.dirname(file), entry))};\n`;
}

// A path as an import names it: `/`-separated, and relative to where it is imported from.
function specifierOf(from, to) {
  const relative = path.relative(from, to).split(path.sep).join('/');
  return relative.startsWith('../') ? relative : `./${relative}`;
}

// A loader is called with its context as `this`, as webpack's loader API calls it.
module.exports = function reactiveStateLoader() {
  // eslint-disable-next-line unicorn/no-this-outside-of-class -- see above
  return rewrite(this.resourcePath, this.getOptions());
};
