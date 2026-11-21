import { describe, expect, it } from 'vitest';

import { renamesColumns } from '../src/sql/renames.ts';

/**
 * Whether a statement's text gives a table's columns names of its own, of which no condition is
 * followed (`renames.ts`): read as PostgreSQL lexes it, and taken for one that does where it
 * cannot be read so.
 */

describe("a statement that names a table's columns otherwise", () => {
  it.each([
    ['FROM users AS u(email, id) WHERE u.id = $1'],
    ['FROM users u (email, id)'],
    ['FROM public.users AS u(email)'],
    ['FROM ONLY users u(email)'],
    ['FROM ONLY (tasks) AS u(project_id, id, title)'],
    ['FROM tasks * AS u(project_id, id)'],
    ['FROM tâches AS u(project_id, id)'],
    ['FROM projects AS é(code, id)'],
    ['FROM U&"projects" AS p(code, id)'],
    ['FROM U&"pr!006Fjects" UESCAPE \'!\' AS p(code, id)'],
    ['FROM postgres.public.projects AS p(code, id)'],
    ['FROM public.user AS u(org_id, id)'],
    ['FROM public.user u(org_id, id)'],
    ['FROM members AS values(user_id, project_id)'],
    ['FROM values AS x(user_id, project_id)'],
    ['FROM public.by AS u(project_id, id, title)'],
    ['FROM by u(project_id, id, title)'],
    ['FROM ordinality AS u(project_id, id)'],
    ['FROM character AS u(project_id, id)'],
    ['FROM within AS w(project_id, id)'],
    ['FROM "tasks" uescape(project_id, id)'],
    ['FROM tasks, (members m(user_id, project_id) JOIN x ON true)'],
    ['FROM projects p JOIN members m ON p.id = m.project_id, tasks AS u(project_id, id, title)'],
    ['FROM projects p JOIN members m USING (id), tasks u(project_id, id)'],
    ['FROM tasks AS set(project_id, id, title)'],
    [', 1. FROM tasks AS u(project_id, id)'],
    [', 1_000. FROM tasks AS u(project_id, id)'],
    ['FROM members m JOIN projects p ON 0 < 1., tasks u(project_id, id)'],
    ['FROM public.as u(project_id, id)'],
    ['FROM (values AS u(project_id, id) JOIN projects p ON true)'],
    ['FROM (values * u(project_id, id) CROSS JOIN projects p)'],
    [
      'FROM tasks t JOIN projects p ON p.id = percentile_disc(0.5) WITHIN GROUP (ORDER BY t.id), tasks u(project_id, id)',
    ],
    ['FROM tasks AS li\u{212A}e(project_id, id)'],
    [
      "FROM tasks t JOIN projects p ON COLLATION FOR (t.title) = 'default', tasks u(project_id, id)",
    ],
    ["FROM COLLATION FOR ('a') AS c, tasks u(project_id, id)"],
    ['FROM tasks t JOIN projects p ON p.id = $1. where, tasks u(project_id, id)'],
    ["FROM (SELECT 1 AS foru) x JOIN projects p ON foru&'1' = 1, tasks u(project_id, id)"],
    ['FROM U&"tasks" UESCAPE E\'!\' u(project_id, id)'],
    ['FROM tasks AS U&"u" UESCAPE E\'!\' (project_id, id)'],
    [', t.u&$$1$$ FROM tasks t, tasks v(project_id, id)'],
    ['FROM tasks t JOIN projects p ON t.n = p.u&$$1$$, tasks v(project_id, id)'],
    [
      'FROM tasks t JOIN projects p ON p.title = U&"text" UESCAPE $$!$$$q$ where 1$q$, tasks v(project_id, id)',
    ],
    ['; DELETE FROM tasks USING tasks u(project_id, id)'],
    ['; MERGE INTO tasks t USING tasks u(project_id, id) ON true WHEN MATCHED THEN DO NOTHING'],
    ['FROM ONLY (tasks) values(project_id, id, title)'],
    ['FROM tasks * values(project_id, id, title)'],
    ['FROM members m JOIN x ON m.id = values, tasks u(project_id, id)'],
    ['FROM set.projects AS u(code, id)'],
    ['FROM members AS set, projects AS u(code, id)'],
    ['FROM members set, projects AS u(code, id)'],
    ['FROM public.where AS u(code, id)'],
    ['FROM public.on AS u(code, id)'],
    ['FROM members m JOIN x ON true, (projects u(code, id) JOIN y ON true)'],
    ['FROM a JOIN b ON (a.x = f(b.y, 1)) JOIN tasks u(project_id, id) ON true'],
    ['FROM members U&"m" UESCAPE \'!\' (user_id, project_id)'],
    ['FROM tasks AS U&"u" UESCAPE \'!\' (project_id, id, title)'],
    ['FROM tasks AS uescape(project_id, id, title)'],
    ['FROM tasks uescape (project_id, id, title)'],
    ['FROM U&"public" UESCAPE \'!\'.members m(user_id, project_id)'],
    ['AS foo$x$, 2 FROM projects AS p(code, id) -- $x$'],
    ['-- a comment\rFROM projects AS p(code, id)'],
    ['FROM tasks WHERE title = $é$ never closed'],
    ['JOIN "users" "u"(email) ON true'],
    ['FROM tasks t, users u(email)'],
    ['FROM (users AS u(email, id) JOIN tasks t ON t.id = u.id)'],
    ['FROM tasks t JOIN ((users u(email)) JOIN x ON true) ON true'],
    ["FROM tasks WHERE title = 'unclosed"],
    ['FROM tasks /* a comment never closed'],
    ['FROM tasks WHERE title = $tag$ never closed'],
    // Of `standard_conforming_strings` off, `\'` is a quote: the alias list is no string's.
    [String.raw`, '\'' FROM tasks AS u(project_id, id) WHERE title = '\''`],
  ])('is %s', (text) => {
    expect(renamesColumns(`SELECT 1 ${text}`)).toBe(true);
  });

  it.each([
    ['select "id" from "tasks" where ("tasks"."project_id" = $1 and "tasks"."done" = $2)'],
    ['select "id" from "tasks" left join "projects" on ("tasks"."project_id" = "projects"."id")'],
    ['select "tasks"."id" from "tasks" "tasks" left join lateral (select 1) "t" on true'],
    ['SELECT * FROM users WHERE (id = 1)'],
    ['SELECT * FROM users u JOIN tasks t USING (id)'],
    ['SELECT * FROM users u WHERE (u.id = 1) ORDER BY (u.id)'],
    ['SELECT * FROM generate_series(1, 3) AS g(i)'],
    ['SELECT 1.5e3, .5, 0x1f, 1_000 FROM tasks t WHERE t.id = $1'],
    ['SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY t.id) FROM tasks t GROUP BY t.title'],
    ['SELECT * FROM (VALUES (1)) AS v(a)'],
    ['SELECT * FROM (SELECT count(*) FROM users) AS s(n)'],
    ['SELECT * FROM (WITH w AS (SELECT 1) SELECT * FROM w) AS s'],
    ['SELECT * FROM (users u JOIN tasks t ON (t.id = u.id))'],
    ['SELECT * FROM users, LATERAL unnest(ARRAY[1]) AS x(y)'],
    ['SELECT * FROM users TABLESAMPLE system (10)'],
    ['SELECT * FROM users UNION (SELECT * FROM users)'],
    ['SELECT a, CASE WHEN (a = 1) THEN 1 END FROM users'],
    ['SELECT a, x AND (y <> z) FROM users'],
    ['SELECT a, NOT (b) FROM users'],
    ['SELECT a FROM users ORDER BY lower(a), f(b)'],
    ['SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY a) FROM users'],
    ['SELECT (a)::character varying(20) FROM users GROUP BY GROUPING SETS ((a))'],
    [
      'SELECT CAST(a AS numeric(10, 2)), count(*) FILTER (WHERE b) OVER (PARTITION BY c) FROM users',
    ],
    ['SELECT * FROM jsonb_to_recordset($1) AS r(a int) JOIN users u ON u.id = r.a'],
    ['SELECT u.name FROM unnest($1::text[]) WITH ORDINALITY AS u(name, at)'],
    ['SELECT price * coalesce(qty, 1), 100 * sum(x) FROM items ORDER BY score * log(2)'],
    ["SELECT a FROM t WHERE b BETWEEN now() - interval '1 day' AND now()"],
    ['SELECT a FROM t WHERE b LIKE c ESCAPE f(d) AND e NOT BETWEEN f(1) AND g(2)'],
    ["SELECT json_object('k' VALUE f(a)), a OPERATOR(pg_catalog.=) b FROM t"],
    ['SELECT (a)::interval second(3), (b)::char varying(5), a AT TIME ZONE coalesce(z, 1) FROM t'],
    ['WITH RECURSIVE t(n) AS (SELECT 1), x AS MATERIALIZED (SELECT 2) SELECT * FROM t, x'],
    ['SELECT CAST(id AS varchar(10)) FROM users'],
    ["SELECT 'FROM users u(email)' FROM users"],
    [String.raw`SELECT E'it\'s FROM users u(email)' FROM users`],
    ['SELECT $q$ FROM users u(email) $q$ FROM users'],
    ['SELECT $é$ FROM users u(email) $é$ FROM users'],
    ['SELECT 1 -- FROM users u(email)\nFROM users'],
    ['SELECT 1 /* FROM /* users */ u(email) */ FROM users'],
  ])('is not %s', (text) => {
    expect(renamesColumns(text)).toBe(false);
  });

  it.each([
    ['CREATE FUNCTION f(a int) RETURNS int IMMUTABLE STRICT LANGUAGE sql RETURN abs(a)'],
    ['CREATE FUNCTION f(a int) RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT a * abs(a); END'],
    ['INSERT INTO t VALUES (1)'],
    ['INSERT INTO t AS a (b, c) VALUES (1, 2)'],
    ['UPDATE t SET (a, b) = (1, 2)'],
  ])('is not %s, of no FROM list', (text) => {
    expect(renamesColumns(text)).toBe(false);
  });

  it('reads a string of escapes after a dollar-quoted body as PostgreSQL does', () => {
    const text = String.raw`SELECT U&"text" UESCAPE $$!$$E'\'' AS a FROM tasks t, tasks v(project_id, id) WHERE t.title <> '-- x'`;

    expect(renamesColumns(text, true)).toBe(true);
  });

  it('reads no string of escapes that goes on after a line, whose rest PostgreSQL reads of escapes', () => {
    const text = [
      "SELECT E''",
      String.raw`'\'', 1 FROM tasks u(project_id, id) WHERE E'\'' <> ''`,
    ].join('\n');

    expect(renamesColumns(text, true)).toBe(true);
  });

  it("reads a string of a backslash as PostgreSQL does where it conforms to the standard's", () => {
    const text = String.raw`SELECT a FROM users WHERE a ~ '\d+' AND b = ''`;

    expect(renamesColumns(text, true)).toBe(false);
    expect(renamesColumns(text)).toBe(true);
  });
});
