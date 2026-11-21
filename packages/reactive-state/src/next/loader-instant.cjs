'use strict';

// Turbopack's CommonJS loader gives a registered blocking page its existing permission unless
// the module exports an instant value of its own. Next's installed peer supplies the parser;
// JSX text, strings and comments therefore cannot become segment configuration.
const loadPeer = process.getBuiltinModule('node:module').createRequire(__filename);
const { parse } = loadPeer('next/dist/compiled/babel/parser');

const PERMISSION = '\nexport const instant = false;\n';

// Only a top-level runtime variable or named value export supplies the segment's own setting.
function exportsInstant(statement) {
  if (statement.type !== 'ExportNamedDeclaration' || statement.exportKind === 'type') return false;
  const declaration = statement.declaration;
  if (declaration?.type === 'VariableDeclaration' && declaration.declare !== true) {
    const declared = declaration.declarations.some(
      (entry) => entry.id.type === 'Identifier' && entry.id.name === 'instant',
    );
    if (declared) return true;
  }
  return statement.specifiers.some((entry) => {
    if (entry.exportKind === 'type') return false;
    const name = entry.exported.type === 'Identifier' ? entry.exported.name : entry.exported.value;
    return name === 'instant';
  });
}

// Page modules may contain TypeScript with JSX, or angle-bracket assertions without JSX.
function statementsOf(source) {
  try {
    return parse(source, { plugins: ['typescript', 'jsx'], sourceType: 'module' }).program.body;
  } catch {
    return parse(source, { plugins: ['typescript'], sourceType: 'module' }).program.body;
  }
}

module.exports = function instantLoader(input) {
  const source = String(input);
  return statementsOf(source).some((statement) => exportsInstant(statement))
    ? source
    : `${source}${PERMISSION}`;
};
