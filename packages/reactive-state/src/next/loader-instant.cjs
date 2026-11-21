'use strict';

// Turbopack's CommonJS loader gives a registered blocking page its existing permission unless the
// module exports an `instant` value of its own. Next's installed peer supplies the parser; JSX
// text, strings and comments therefore cannot become segment configuration.
//
// Next.js reads the setting off the module's exports as it runs, whatever statement exports it: a
// constant, a pattern that binds the name, a function, a list of exports. Each is the page's own
// setting, and nothing is added to it. The permission is otherwise a constant named `instant`,
// unless the module names anything so already — a constant it does not export, an import, a
// function, a `var` in a block — which a second declaration of the name would collide with: it is
// then a constant of a name the module has nowhere, exported as `instant`.
const loadPeer = process.getBuiltinModule('node:module').createRequire(__filename);
const { parse } = loadPeer('next/dist/compiled/babel/parser');

const NAME = 'instant';
const PERMISSION = `\nexport const ${NAME} = false;\n`;

// What an export statement declares a value by, beside a list of variables: each by its one name.
const NAMED_DECLARATIONS = new Set([
  'ClassDeclaration',
  'FunctionDeclaration',
  'TSEnumDeclaration',
  'TSModuleDeclaration',
]);

// Whether a variable's pattern binds `instant`: as its name, or anywhere in an object's or a
// list's, nested, a rest's and one with a default among them.
function bindsInstant(pattern) {
  const pending = [pattern];
  while (pending.length > 0) {
    const each = pending.pop();
    if (each.type === 'Identifier' && each.name === NAME) return true;
    pending.push(...boundIn(each));
  }
  return false;
}

// What a pattern holds that binds: never a property's key, nor what a default reads.
function boundIn(pattern) {
  switch (pattern.type) {
    case 'ArrayPattern': {
      // A hole binds nothing.
      return pattern.elements.filter(Boolean);
    }
    case 'AssignmentPattern': {
      return [pattern.left];
    }
    case 'ObjectPattern': {
      return pattern.properties.map((property) => property.value ?? property);
    }
    case 'RestElement': {
      return [pattern.argument];
    }
    default: {
      return [];
    }
  }
}

// Whether a declaration an export statement holds declares `instant` as a value.
function declaresInstant(declaration) {
  if (declaration.declare === true) return false;
  if (declaration.type === 'VariableDeclaration') {
    return declaration.declarations.some((entry) => bindsInstant(entry.id));
  }
  return NAMED_DECLARATIONS.has(declaration.type) && declaration.id.name === NAME;
}

// Only a top-level value export of the name supplies the segment's own setting.
function exportsInstant(statement) {
  // TypeScript's `export import instant = …` is a statement of its own kind.
  if (statement.type === 'TSImportEqualsDeclaration') {
    return statement.isExport === true && statement.id.name === NAME;
  }
  if (statement.type !== 'ExportNamedDeclaration' || statement.exportKind === 'type') return false;
  if (statement.declaration && declaresInstant(statement.declaration)) return true;
  return statement.specifiers.some((entry) => {
    if (entry.exportKind === 'type') return false;
    const name = entry.exported.type === 'Identifier' ? entry.exported.name : entry.exported.value;
    return name === NAME;
  });
}

// Every name an identifier of the module has, wherever it stands: a binding's, a reference's, a
// property's, a type's. A declaration of a name that is none of them collides with nothing.
function namesIn(program) {
  const names = new Set();
  const pending = [program];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node.type === 'Identifier') names.add(node.name);
    for (const held of Object.values(node)) {
      const items = Array.isArray(held) ? held : [held];
      for (const item of items) {
        // What a node holds that is one itself says its type, as no position or text does.
        if (typeof item?.type === 'string') pending.push(item);
      }
    }
  }
  return names;
}

// The permission for a module that names `names`: under `instant` itself where nothing has the
// name, and else under the first name of its kind that nothing has.
function permissionFor(names) {
  if (!names.has(NAME)) return PERMISSION;
  let count = 1;
  while (names.has(`${NAME}$${count}`)) count += 1;
  const local = `${NAME}$${count}`;
  return `\nconst ${local} = false;\nexport { ${local} as ${NAME} };\n`;
}

// Page modules may contain TypeScript with JSX, or angle-bracket assertions without JSX.
function programOf(source) {
  try {
    return parse(source, { plugins: ['typescript', 'jsx'], sourceType: 'module' }).program;
  } catch {
    return parse(source, { plugins: ['typescript'], sourceType: 'module' }).program;
  }
}

module.exports = function instantLoader(input) {
  const source = String(input);
  const program = programOf(source);
  return program.body.some((statement) => exportsInstant(statement))
    ? source
    : `${source}${permissionFor(namesIn(program))}`;
};
