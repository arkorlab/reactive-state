import { describe, expect, it } from 'vitest';

import { changesContext, namesTemporaryRowType } from '../src/sql/guards.ts';
import { namesTypeByText, unknownTypeCast } from '../src/sql/type-guards.ts';

/** A bulk write's parameters: some 140,000 tokens, past the arguments a JavaScript call takes. */
const LONG = { values: 70_000 } as const;

/** PostgreSQL's keyword classes, of the words the tests below read. */
const KEYWORDS = {
  all: new Set([
    'create',
    'function',
    'ilike',
    'like',
    'range',
    'return',
    'returns',
    'rows',
    'select',
    'text',
  ]),
  nonTypes: new Set(['create', 'select']),
  reserved: new Set(['create', 'select']),
} as const;

describe('sql admission tokens', () => {
  it.each([
    'SET search_path = other',
    'SELECT 1; /* context */ RESET ROLE',
    'DISCARD ALL',
    "SELECT pg_catalog.set_config('role', $1, true)",
    'SELECT "set_config"(\'search_path\', $1, true)',
    String.raw`SELECT U&"set\005fconfig"('role', $1, true)`,
    'SET transaction.name = 1',
    'SET "transaction".name = 1',
    'SET TRANSACTION READ ONLY; SET search_path = other',
    'ROLLBACK TO SAVEPOINT here',
  ])('observes direct query context changes: %s', (statement) => {
    expect(changesContext(statement, true)).toBe(true);
  });

  it.each([
    "SELECT 'set_config(' AS title",
    'SELECT $$set_config($$ AS title',
    'SELECT "Set_Config"(id) FROM tasks',
    'SELECT set_config FROM tasks',
    'SELECT reset FROM tasks',
    'SELECT 1 /* ; RESET ROLE */',
    String.raw`SELECT "named".id, E'it\'s set_config(' FROM tasks AS "named"`,
    'SET TRANSACTION READ ONLY',
    'set transaction isolation level serializable',
    "SET TRANSACTION SNAPSHOT '00000003-0000001B-1'",
  ])('leaves literal values and ordinary names alone: %s', (statement) => {
    expect(changesContext(statement, true)).toBe(false);
  });

  it.each([
    "SELECT pg_input_is_valid('(1)', 'pg_temp.staging')",
    "SELECT pg_catalog.pg_input_error_info('(1)', 'staging')",
    'SELECT "to_regtype"(\'staging\')',
    "SELECT to_regclass('pg_temp.staging')",
    "SELECT to_regtypemod('staging')",
    "SELECT to_regprocedure('f(staging)')",
    "SELECT to_regoperator('=(staging,staging)')",
    "SELECT 'pg_temp.staging'::regtype",
    "SELECT 'staging'::pg_catalog.regclass",
    "SELECT 'f(staging)'::regprocedure",
    "SELECT '=(staging,staging)'::regoperator",
    'SELECT $1::regtype',
    "SELECT ('pg_temp.' || 'staging')::regtype",
    "SELECT CAST('staging' AS regclass)",
    "SELECT regtype 'staging'",
    "SELECT pg_catalog.regclass 'staging'",
    "SELECT '{pg_temp.staging}'::_regtype",
    "SELECT _regclass '{staging}'",
    "SELECT '{pg_temp.staging}'::regtype[]",
    "SELECT regtypein('staging')",
    "SELECT pg_catalog.regclassin('staging')",
    "SELECT regprocedurein('f(staging)')",
    "SELECT regoperatorin('=(staging,staging)')",
    "SELECT 'pg_temp.staging'::text::regclass",
    'SELECT $1::text::regtype',
    "SELECT CASE WHEN true THEN 'staging' END::regclass",
    'SELECT title::regtype FROM tasks',
    'SELECT tableoid::regclass FROM tasks',
    'SELECT (tableoid)::regclass FROM tasks',
    'SELECT t.tableoid::pg_catalog.regclass FROM tasks AS t',
    'SELECT CAST(tableoid AS regclass) FROM tasks',
    'SELECT CAST((tableoid) AS regclass) FROM tasks',
  ])('reads a type or a relation named by text: %s', (statement) => {
    expect(namesTypeByText(statement, true)).toBe(true);
  });

  it.each([
    'SELECT tableoid FROM tasks',
    "SELECT 'english'::regconfig",
    "SELECT 'to_regtype(' AS title",
    'SELECT to_regtype FROM tasks',
    "SELECT app.to_regtype('staging')",
    "SELECT 'staging' AS regtype",
    "SELECT title FROM tasks WHERE status = 'staging'",
  ])('leaves a text that names no type alone: %s', (statement) => {
    expect(namesTypeByText(statement, true)).toBe(false);
  });

  it('reads a statement of more tokens than a call takes arguments', () => {
    const values = `(${'$1, '.repeat(LONG.values)}$1)`;

    expect(changesContext(`INSERT INTO "tasks" VALUES ${values}`, true)).toBe(false);
    expect(changesContext(`SELECT "id" FROM "tasks" WHERE "id" IN ${values}`, true)).toBe(false);
  });

  it.each([
    "SELECT (ROW('a')::pg_temp.staging).x",
    "SELECT (ROW('a')::pg_temp_1.staging).x",
    "SELECT (ROW('a')::staging).x",
    "SELECT CAST(ROW('a') AS staging)",
    "SELECT staging '(a)'",
    "SELECT ARRAY[ROW('a')]::staging[]",
  ])('finds temporary row type names: %s', (statement) => {
    expect(
      namesTemporaryRowType(
        statement,
        [{ name: 'staging', schema: 'pg_temp_1', visible: true }],
        true,
      ),
    ).toBe(true);
  });

  it.each([
    "SELECT 'staging' AS title",
    "SELECT (ROW('a')::public.staging).x",
    'SELECT (ROW(\'a\')::"Staging").x',
    'SELECT title FROM tasks /* staging */',
  ])('keeps other schemas, cases and literal values distinct: %s', (statement) => {
    expect(
      namesTemporaryRowType(
        statement,
        [{ name: 'staging', schema: 'pg_temp_1', visible: true }],
        true,
      ),
    ).toBe(false);
  });

  it.each([
    "SELECT ROW('a')::new_type",
    "SELECT CAST(ROW('a') AS new_type)",
    "SELECT new_type '(a)'",
    "SELECT pg_temp.new_type '(a)'",
    "SELECT ARRAY[ROW('a')]::new_type[]",
    "SELECT value '(a)'",
    "SELECT DISTINCT ON (id) value '(a)' FROM tasks",
    "SELECT id FROM tasks WHERE id BETWEEN value '(a)' AND value '(z)'",
    "SELECT CASE new_type '(1)'::text WHEN '(1)' THEN 'same' ELSE 'different' END",
    "SELECT trim(BOTH new_type '(a)'::text FROM title) FROM tasks",
    "SELECT overlay(title PLACING new_type '(a)'::text FROM 1) FROM tasks",
    "SELECT like '(a)'",
    "SELECT CASE like '(a)' WHEN 'a' THEN true ELSE false END",
    "SELECT DISTINCT ON (id) like '(a)' FROM tasks",
    "SELECT similar '(a)'",
    "SELECT CASE similar '(a)' WHEN 'a' THEN true ELSE false END",
    'SELECT 1::"dec"',
    'SELECT 1::public.dec',
    "SELECT ROW('1')::double",
    "SELECT double '(1)'",
    `SELECT json_value('{"v":"(1)"}'::jsonb, '$.v' RETURNING new_type)::text`,
    `SELECT json_query('{"v":"(1)"}'::jsonb, '$.v' RETURNING pg_temp.new_type)`,
    `SELECT json_value('{"v":"(1)"}'::jsonb, '$.v' PASSING passing '(1)' AS x)`,
    "SELECT passing '(1)'",
    "SELECT uescape '(1)'",
    "SELECT json_object(key '(a)'::text : 1)",
    "SELECT 'x' OPERATOR(pg_catalog.||) like '(a)'",
    "SELECT 'x' OPERATOR(pg_catalog.||) ilike '(a)'",
    "SELECT 'x' OPERATOR(pg_catalog.||) escape '(a)'",
    "SELECT json_object('a' OPERATOR(pg_catalog.||) value '(b)' : 1)",
    "SELECT substring('a' OPERATOR(pg_catalog.||) similar '(a)', 1)",
    "WITH x AS (SELECT 'a' OPERATOR(pg_catalog.||) rows '(a)' preceding) SELECT * FROM x",
    "DELETE FROM tasks RETURNING WITH (OLD AS o) like '(a)'",
    "SELECT over(rows '(a)', preceding) FROM tasks",
    "SELECT DISTINCT ON (a) over(rows '(a)', preceding) FROM tasks",
    "SELECT 'z' OPERATOR(pg_catalog.||) over(rows '(a)', preceding) FROM tasks",
    "DELETE FROM tasks RETURNING WITH (OLD AS o) over(rows '(a)', preceding)",
    "SELECT postgres.window.as(rows '(a)', preceding) FROM tasks",
    "SELECT count(*) OVER (ORDER BY t.using || rows '(a)' ROWS 1 PRECEDING) FROM tasks AS t",
    "SELECT pg_temp.operator(3) '1'",
    "SELECT a FROM tasks FETCH FIRST operator(3) '1' ROWS ONLY",
    "SELECT over(range '(a)' || preceding) FROM tasks",
    "SELECT over(groups '(a)' COLLATE preceding) FROM tasks",
    "CREATE TABLE x (a text GENERATED ALWAYS AS (rows '(a)' || preceding) STORED)",
    "WITH x AS (SELECT 1 FROM tasks AS preceding FETCH FIRST range '1' ROWS ONLY FOR UPDATE OF preceding) SELECT * FROM x",
    "WITH a AS (SELECT 1), b AS (SELECT 1 FROM tasks FETCH FIRST rows '1' ROWS ONLY) SELECT preceding FROM b",
    "SELECT foo(3) '1'",
    "SELECT pg_temp.foo(3) '1'",
    "SELECT xmlserialize(content '<a/>' AS new_type)",
    "SELECT first '(1)'",
    "SELECT next '(1)'",
    "SELECT title FROM tasks FETCH FIRST first '(1)' ROWS ONLY",
    "SELECT title FROM tasks FETCH NEXT new_type '(1)' ROWS ONLY",
    "SELECT rows '(1)' preceding",
    'SELECT "id", range \'(1)\' preceding FROM tasks',
    "WITH x AS (SELECT rows '(1)' preceding) SELECT 1",
    `SELECT sum(id) OVER (ORDER BY "id" ROWS rows '(1)' PRECEDING) FROM tasks`,
    `SELECT sum(id) OVER (ORDER BY "id" ROWS BETWEEN rows '(1)' PRECEDING AND CURRENT ROW) FROM tasks`,
    `SELECT sum(id) OVER (PARTITION BY rows '(1)') FROM tasks`,
    "SELECT pg_temp.between '(1)'::text",
    "SELECT pg_temp.like '(1)'",
    "SELECT public.passing '(1)'",
    "SELECT xmlexists('//a' PASSING passing '<a/>')",
    "SELECT xmlexists('//a' PASSING BY REF ref '<a/>')",
    "SELECT 'a' || uescape '(1)'",
    "SELECT U&'a' || uescape '(1)'",
    "SELECT * FROM json_to_record('{}') AS x(v new_type)",
    "SELECT * FROM json_to_record('{}') x(v new_type)",
    "SELECT * FROM ROWS FROM(json_to_record('{}') AS (v new_type)) AS x",
  ])('refuses types unknown to the initial catalog: %s', (statement) => {
    expect(
      unknownTypeCast(
        statement,
        [
          { name: 'text', schema: 'pg_catalog', visible: true },
          { name: 'jsonb', schema: 'pg_catalog', visible: true },
        ],
        true,
      ),
    ).toBe(true);
  });

  it.each([
    "SELECT 'a'::text",
    "SELECT 'a'::pg_catalog.text",
    'SELECT CAST(1 AS integer)',
    "SELECT timestamp '2026-11-04'",
    "SELECT 'a' AS title",
    "SELECT CASE WHEN true THEN 'a' ELSE 'b' END",
    "SELECT id FROM tasks WHERE id BETWEEN 'a' AND 'z'",
    "SELECT id FROM tasks WHERE id BETWEEN SYMMETRIC 'a' AND 'z'",
    "SELECT convert('abc' USING 'UTF8')",
    'SELECT "title" FROM tasks WHERE "title" LIKE \'F%\'',
    'SELECT "title" FROM tasks WHERE "title" ILIKE \'f%\'',
    'SELECT "title" FROM tasks WHERE "title" NOT LIKE \'F%\'',
    "SELECT 'text'::text LIKE 't%'",
    "SELECT CURRENT_USER LIKE 'p%'",
    'SELECT 1::dec',
    'SELECT CAST(1 AS DEC)',
    'SELECT CAST(1 AS DOUBLE PRECISION)',
    `SELECT json_value('{}', '$.v' RETURNING text)`,
    `SELECT json_value('{}', '$.v' PASSING 'v' AS x)`,
    `SELECT json_exists('{}', '$.v' PASSING 'v' AS x)`,
    `SELECT json_query('{}', '$.v' PASSING 'v' AS x)`,
    'SELECT * FROM generate_series(1, 2) AS x(v)',
    'SELECT sum(id) OVER (PARTITION BY id) FROM tasks',
    `SELECT substring('abc' SIMILAR '%#"b#"%' ESCAPE '#')`,
    "SELECT double precision '1'",
    "SELECT character varying 'x'",
    "SELECT timestamp with time zone '2026-11-04'",
    "SELECT U&'d!0061t' UESCAPE '!'",
    "SELECT title FROM tasks FETCH FIRST '1' ROWS ONLY",
    "SELECT title FROM tasks OFFSET 1 ROWS FETCH NEXT '2' ROWS ONLY",
    "SELECT sum(id) OVER (ROWS '1' PRECEDING) FROM tasks",
    `SELECT sum(id) OVER (ORDER BY "id" ROWS '1' PRECEDING) FROM tasks`,
    `SELECT sum(id) OVER (ORDER BY "id" DESC RANGE '1' PRECEDING) FROM tasks`,
    `SELECT sum(id) OVER (ORDER BY "id" NULLS LAST GROUPS '1' PRECEDING) FROM tasks`,
    `SELECT sum(id) OVER w FROM tasks WINDOW w AS (ORDER BY "id" ROWS '1' PRECEDING)`,
    `SELECT sum(id) OVER (ORDER BY "id" ROWS '1'::int PRECEDING) FROM tasks`,
    `SELECT sum(id) OVER (ORDER BY "id" ROWS '1' + 1 PRECEDING) FROM tasks`,
    `SELECT sum(id) OVER (ORDER BY "id" USING < ROWS '1' PRECEDING) FROM tasks`,
    `SELECT sum(id) OVER (ORDER BY "id" USING OPERATOR(pg_catalog.<) ROWS '1' PRECEDING) FROM tasks`,
    `SELECT sum(id) OVER (ORDER BY "id" NULLS FIRST ROWS '1' PRECEDING) FROM tasks`,
    `SELECT sum(id) FILTER (WHERE "id" > 1) OVER (ROWS '1' PRECEDING) FROM tasks`,
    `SELECT sum(id) OVER v FROM tasks WINDOW w AS (ORDER BY "id"), v AS (ROWS '1' PRECEDING)`,
    "SELECT numeric(3) '1'",
    "SELECT varchar(3) 'x'",
    "SELECT character varying(3) 'x'",
    "SELECT bit varying(3) '101'",
    "SELECT timestamp(3) '2026-11-04'",
    "SELECT DISTINCT ON (id) 'a' FROM tasks",
    "SELECT 'a' OPERATOR(pg_catalog.||) 'b'",
    "SELECT 'a' OPERATOR(||) 'b'",
    `SELECT x.operator(1) LIKE 'y'`,
    "SELECT xmlserialize(content '<a/>' AS text)",
    "SELECT CASE WHEN true THEN 'a' END LIKE 'a'",
    "SELECT user LIKE 'a'",
    "SELECT json_object(.5 VALUE 'x')",
    "SELECT XMLEXISTS('//a' PASSING '<a/>')",
    "SELECT xmlexists('//a' PASSING BY REF '<a/>')",
    "SELECT xmlexists('//a' PASSING BY VALUE '<a/>' BY VALUE)",
    String.raw`SELECT U&'d\0061t' uescape '\' AS title`,
    'SELECT CAST(t.as AS text) FROM tasks AS t',
    "SELECT json_value(t.returning, '$') FROM tasks AS t",
    "SELECT json_value(t.returning, '$' RETURNING text) FROM tasks AS t",
    "SELECT count(*) OVER (ORDER BY t.* ROWS '1' PRECEDING) FROM tasks AS t",
    "SET TIME ZONE 'UTC'",
    "SET LOCAL TIME ZONE 'UTC'",
    "SET SESSION TIME ZONE 'UTC'",
    "SET ROLE 'x'",
    "SET LOCAL ROLE 'x'",
    "SET SESSION ROLE 'x'",
    "SET SESSION AUTHORIZATION 'x'",
    "SET LOCAL SESSION AUTHORIZATION 'x'",
    "SET SCHEMA 'x'",
    "SET LOCAL SCHEMA 'x'",
    "SET NAMES 'x'",
    "SET LOCAL NAMES 'x'",
  ])('admits known types and ordinary literals: %s', (statement) => {
    expect(
      unknownTypeCast(statement, [{ name: 'text', schema: 'pg_catalog', visible: true }], true),
    ).toBe(false);
  });

  it.each([
    "CREATE FUNCTION g() RETURNS text RETURN like '(a)'",
    "CREATE FUNCTION g() RETURNS text RETURN new_type '(a)'",
    "SELECT xmlexists(operator(*) OVER (ROWS like '1' PRECEDING) PASSING '<a/>') FROM tasks",
    "SELECT xmlexists(operator(t.*) OVER (RANGE ilike '1' PRECEDING) PASSING '<a/>') FROM tasks AS t",
    "SELECT xmlexists(operator(*) OVER (ROWS '1' PRECEDING) PASSING '<a/>') FROM tasks",
    'SELECT CAST(t.as AS new_type) FROM tasks AS t',
    "SELECT json_value(t.returning, '$' RETURNING new_type) FROM tasks AS t",
    "SELECT rows '1' FROM tasks",
    "SELECT zone 'UTC'",
    "SELECT something.zone 'UTC'",
    "SELECT role 'x'",
    "SELECT names 'x'",
    "SELECT schema 'x'",
    "SELECT set.role 'x'",
    "SELECT local role 'x'",
  ])('refuses what only a keyword class tells from a typed literal: %s', (statement) => {
    expect(
      unknownTypeCast(
        statement,
        [{ name: 'text', schema: 'pg_catalog', visible: true }],
        true,
        KEYWORDS,
      ),
    ).toBe(true);
  });

  it.each([
    `SELECT * FROM json_table('{}', '$' COLUMNS(v FOR ORDINALITY)) AS x`,
    `SELECT * FROM json_table('{}', '$' COLUMNS(v text PATH '$.v')) AS x`,
    `SELECT * FROM xmltable('/x' PASSING '<x/>' COLUMNS v text PATH '.') AS x`,
    "SELECT * FROM json_to_record('{}') AS x(v text)",
  ])('refuses typed table constructs whose type clauses are not proven: %s', (statement) => {
    expect(
      unknownTypeCast(statement, [{ name: 'text', schema: 'pg_catalog', visible: true }], true),
    ).toBe(true);
  });
});
