'use strict';

// Turbopack's CommonJS loader gives a registered blocking page its existing permission unless the
// module exports an `instant` value of its own. Next's installed peer supplies the parser; JSX
// text, strings and comments therefore cannot become segment configuration.
//
// Next.js reads the setting off the module's exports as it runs, whatever statement exports it: a
// constant, a pattern that binds the name, a function, a list of exports. Each is the page's own
// setting, and nothing is added to it. An export TypeScript erases is none, as nothing of it is
// there as the module runs: a type, an interface, anything under `declare`, a type's import, a
// namespace that holds nothing but types, and a list that exports the name of one of those. The
// permission is otherwise a constant named `instant`, unless the module names anything so already
// (a constant it does not export, an import, a function, a `var` in a block), which a second
// declaration of the name would collide with: it is then a constant of a name the module has
// nowhere, exported as `instant`.
const loadPeer = process.getBuiltinModule('node:module').createRequire(__filename);
const { parse } = loadPeer('next/dist/compiled/babel/parser');

const NAME = 'instant';
const PERMISSION = `\nexport const ${NAME} = false;\n`;

// What declares a type by its one name and no value: TypeScript erases each.
const TYPE_DECLARATIONS = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration']);

// Whether a variable's pattern binds `name`: as its own name, or anywhere in an object's or a
// list's, nested, a rest's and one with a default among them.
function binds(pattern, name) {
  const pending = [pattern];
  while (pending.length > 0) {
    const each = pending.pop();
    if (each.type === 'Identifier' && each.name === name) return true;
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

// How a statement of the module declares `name`: as a `type`, which TypeScript erases with what a
// list exports by the name; as a `value`, an ambient one (`declare`) too, whose export in a list
// the compiler keeps; or not at all (`none`). An import of the name declares it.
function declaredAs(declaration, name) {
  if (declaration.type === 'ImportDeclaration') {
    const bound = declaration.specifiers.find((entry) => entry.local.name === name);
    if (bound === undefined) return 'none';
    return declaration.importKind === 'type' || bound.importKind === 'type' ? 'type' : 'value';
  }
  if (declaration.type === 'VariableDeclaration') {
    return declaration.declarations.some((entry) => binds(entry.id, name)) ? 'value' : 'none';
  }
  if (declaration.id?.name !== name) return 'none';
  return isType(declaration) ? 'type' : 'value';
}

// Only a top-level export that leaves a value by the name as the module runs supplies the
// segment's own setting (`statements` are the module's, which a list's names are read in).
function exportsInstant(statement, statements) {
  // TypeScript's `export import instant = …` is a statement of its own kind.
  if (statement.type === 'TSImportEqualsDeclaration') {
    return statement.isExport === true && declaredAs(statement, NAME) === 'value';
  }
  if (statement.type !== 'ExportNamedDeclaration' || statement.exportKind === 'type') return false;
  const { declaration } = statement;
  if (!declaration) return listsInstant(statement, statements);
  // What `declare` says is elsewhere, and so is a function of a signature alone (no body).
  const ambient = declaration.declare === true || declaration.type === 'TSDeclareFunction';
  return !ambient && declaredAs(declaration, NAME) === 'value';
}

// Whether a namespace holds a value. TypeScript erases one that holds nothing but types (type
// aliases, interfaces, and namespaces that hold nothing but those), and an empty one with them.
function holdsValue(namespace) {
  const pending = [namespace];
  while (pending.length > 0) {
    const { body } = pending.pop();
    // `namespace a.b {}` holds the namespace `b`, and nothing else.
    const held = body.type === 'TSModuleDeclaration' ? [body] : body.body;
    for (const statement of held) {
      const declared = statement.declaration ?? statement;
      if (declared.type === 'TSModuleDeclaration') {
        pending.push(declared);
      } else if (!TYPE_DECLARATIONS.has(declared.type)) {
        return true;
      }
    }
  }
  return false;
}

// Whether what a declaration declares by its one name is a type alone: a type alias, an
// interface, a type's `import … =`, a namespace that holds no value.
function isType(declaration) {
  if (declaration.type === 'TSImportEqualsDeclaration') return declaration.importKind === 'type';
  if (declaration.type === 'TSModuleDeclaration') return !holdsValue(declaration);
  return TYPE_DECLARATIONS.has(declaration.type);
}

// Whether a list of exports exports a value as `instant`, and not a type under that name alone.
function listsInstant(statement, statements) {
  return statement.specifiers.some((entry) => {
    if (entry.exportKind === 'type') return false;
    const name = entry.exported.type === 'Identifier' ? entry.exported.name : entry.exported.value;
    if (name !== NAME) return false;
    // Whether what another module exports is a type cannot be told here: it is taken for a value.
    const own = !statement.source && entry.type === 'ExportSpecifier';
    return !(own && namesTypeAlone(entry.local.name, statements));
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

// Whether the module declares `name` as a type and nowhere as a value: a list that exports it then
// exports nothing that is there as the module runs. Read of the module's own statements, as the
// compiler reads them for it (a `var` in a block is none of them).
function namesTypeAlone(name, statements) {
  const kinds = new Set(
    statements.map((statement) => declaredAs(statement.declaration ?? statement, name)),
  );
  return kinds.has('type') && !kinds.has('value');
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
  return program.body.some((statement) => exportsInstant(statement, program.body))
    ? source
    : `${source}${permissionFor(namesIn(program))}`;
};
