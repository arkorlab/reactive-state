import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  notExists,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

import { member, organization, type Orm, teamInvitations, user } from './sqlite-oracle.ts';

/**
 * The statements the oracle holds to what a render follows: what Drizzle writes of joins, subqueries
 * and relational queries, and of what a term may stand under to say nothing of a row.
 */

/** The values a statement of the oracle asks by. */
export interface Picks {
  readonly organization: string;
  readonly user: string;
  readonly other: string;
  readonly slug: string;
  readonly github: string;
}

/** A statement of the oracle: what it answers of `picks`. */
export type Shape = (db: Orm, picks: Picks) => Promise<unknown>;

const STAMP = { later: 4 } as const;
const PAGE = { first: 1, rows: 2 } as const;

/** The seat of an invitation's inviter in its organization, of a query around it. */
function inviterSeat(db: Orm) {
  return db
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.organizationId, teamInvitations.organizationId),
        eq(member.userId, teamInvitations.inviterUserId),
      ),
    );
}

const joins: Readonly<Record<string, Shape>> = {
  aggregate: (db, picks) => {
    return db
      .select({ organization: member.organizationId, seats: count() })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, picks.organization))
      .groupBy(member.organizationId);
  },
  byBoolean: (db, picks) => {
    return db
      .select({ id: member.id })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(and(eq(member.organizationId, picks.organization), eq(user.verified, false)))
      .orderBy(asc(member.id));
  },
  byEachSide: (db, picks) => {
    return db
      .select({ id: member.id })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(and(eq(member.organizationId, picks.organization), eq(user.githubId, picks.github)));
  },
  byList: (db, picks) => {
    return db
      .select({ id: member.id, name: user.name })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(inArray(member.organizationId, [picks.organization, 'o2']))
      .orderBy(asc(member.id));
  },
  bySlug: (db, picks) => {
    return db
      .select({ id: organization.id, role: member.role })
      .from(organization)
      .innerJoin(member, eq(member.organizationId, organization.id))
      .where(and(eq(organization.slug, picks.slug), eq(member.userId, picks.user)));
  },
  chain: (db, picks) => {
    return db
      .select({ id: teamInvitations.id, name: organization.name, by: user.name })
      .from(teamInvitations)
      .innerJoin(organization, eq(organization.id, teamInvitations.organizationId))
      .innerJoin(user, eq(user.id, teamInvitations.inviterUserId))
      .where(eq(teamInvitations.githubId, picks.github))
      .orderBy(desc(teamInvitations.id));
  },
  distinct: (db, picks) => {
    return db
      .selectDistinct({ name: user.name })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, picks.organization))
      .orderBy(asc(user.name));
  },
  having: (db, picks) => {
    return db
      .select({ organization: member.organizationId, seats: count() })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.userId, picks.user))
      .groupBy(member.organizationId)
      .having(sql`count(*) > 0`);
  },
  offset: (db, picks) => {
    return db
      .select({ id: member.id, user: user.id })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, picks.organization))
      .orderBy(asc(member.id))
      .limit(PAGE.rows)
      .offset(PAGE.first);
  },
  orAcross: (db, picks) => {
    return db
      .select({ id: member.id, name: user.name })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(or(eq(member.organizationId, picks.organization), eq(user.githubId, picks.github)))
      .orderBy(asc(member.id));
  },
  orderedLimit: (db, picks) => {
    return db
      .select({ id: member.id, name: user.name })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, picks.organization))
      .orderBy(asc(user.name), asc(member.id))
      .limit(1);
  },
  roster: (db, picks) => {
    return db
      .select({ id: member.id, role: member.role, name: user.name })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, picks.organization))
      .orderBy(asc(member.createdAt), asc(member.id));
  },
  selfAlias: (db, picks) => {
    const other = alias(member, 'other');
    return db
      .select({ id: member.id, other: other.id })
      .from(member)
      .innerJoin(
        other,
        and(eq(other.organizationId, member.organizationId), eq(other.userId, picks.other)),
      )
      .where(eq(member.userId, picks.user))
      .orderBy(asc(member.id), asc(other.id));
  },
  transitive: (db, picks) => {
    return db
      .select({ id: teamInvitations.id, seat: member.id })
      .from(teamInvitations)
      .innerJoin(member, eq(member.organizationId, teamInvitations.organizationId))
      .where(and(eq(member.organizationId, picks.organization), eq(member.userId, picks.user)))
      .orderBy(asc(teamInvitations.id), asc(member.id));
  },
};

/** A term of the left table in a `LEFT JOIN`'s `ON`, which restricts no row of it. */
export const leftTableTerm: Shape = (db, picks) => {
  return db
    .select({ id: user.id, seat: member.id })
    .from(user)
    .leftJoin(member, and(eq(member.userId, user.id), eq(user.id, picks.user)))
    .orderBy(asc(user.id), asc(member.id));
};

const leftJoins: Readonly<Record<string, Shape>> = {
  anti: (db, picks) => {
    return db
      .select({ id: user.id })
      .from(user)
      .leftJoin(
        member,
        and(eq(member.userId, user.id), eq(member.organizationId, picks.organization)),
      )
      .where(isNull(member.id))
      .orderBy(asc(user.id));
  },
  byLater: (db, picks) => {
    return db
      .select({ id: teamInvitations.id, by: user.name })
      .from(teamInvitations)
      .leftJoin(user, eq(user.id, teamInvitations.inviterUserId))
      .where(
        and(
          eq(teamInvitations.organizationId, picks.organization),
          gt(teamInvitations.expiresAt, STAMP.later),
        ),
      )
      .orderBy(desc(teamInvitations.expiresAt), desc(teamInvitations.id));
  },
  chained: (db, picks) => {
    return db
      .select({ id: teamInvitations.id, by: user.name, seat: member.id })
      .from(teamInvitations)
      .leftJoin(user, eq(user.id, teamInvitations.inviterUserId))
      .leftJoin(
        member,
        and(eq(member.userId, user.id), eq(member.organizationId, teamInvitations.organizationId)),
      )
      .where(eq(teamInvitations.organizationId, picks.organization))
      .orderBy(asc(teamInvitations.id), asc(member.id));
  },
  chainedDeep: (db, picks) => {
    return db
      .select({ id: user.id, seat: member.id, name: organization.name })
      .from(user)
      .leftJoin(member, eq(member.userId, user.id))
      .leftJoin(organization, eq(organization.id, member.organizationId))
      .where(eq(user.id, picks.user))
      .orderBy(asc(member.id));
  },
  innerThenLeft: (db, picks) => {
    return db
      .select({ id: member.id, by: user.name, name: organization.name })
      .from(member)
      .innerJoin(
        user,
        and(eq(user.id, member.userId), eq(member.organizationId, picks.organization)),
      )
      .leftJoin(organization, eq(organization.id, member.organizationId))
      .orderBy(asc(member.id));
  },
  leftTableTerm,
  leftThenInner: (db, picks) => {
    return db
      .select({ id: user.id, seat: member.id, name: organization.name })
      .from(user)
      .leftJoin(member, eq(member.userId, user.id))
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(eq(user.githubId, picks.github))
      .orderBy(asc(member.id));
  },
  selected: (db, picks) => {
    return db
      .select({ id: member.id, user: member.userId, name: user.name })
      .from(member)
      .leftJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, picks.organization))
      .orderBy(asc(member.id));
  },
  whereRight: (db, picks) => {
    return db
      .select({ id: member.id, name: user.name })
      .from(member)
      .leftJoin(user, eq(user.id, member.userId))
      .where(and(eq(member.organizationId, picks.organization), eq(user.githubId, picks.github)));
  },
};

const subqueries: Readonly<Record<string, Shape>> = {
  derived: (db, picks) => {
    const some = db
      .select()
      .from(member)
      .where(eq(member.organizationId, picks.organization))
      .orderBy(asc(member.id))
      .limit(PAGE.rows)
      .as('some');
    return db
      .select({ id: some.id, name: user.name })
      .from(some)
      .innerJoin(user, eq(user.id, some.userId));
  },
  exists: (db, picks) => {
    const seat = inviterSeat(db);
    return db
      .select({ id: teamInvitations.id })
      .from(teamInvitations)
      .where(and(eq(teamInvitations.organizationId, picks.organization), exists(seat)));
  },
  existsUnderOr: (db, picks) => {
    const inviterAnywhere = db
      .select({ id: member.id })
      .from(member)
      .where(eq(member.userId, teamInvitations.inviterUserId));
    return db
      .select({ id: teamInvitations.id })
      .from(teamInvitations)
      .where(or(eq(teamInvitations.organizationId, picks.organization), exists(inviterAnywhere)))
      .orderBy(asc(teamInvitations.id));
  },
  inSubquery: (db, picks) => {
    const seated = db
      .select({ id: member.userId })
      .from(member)
      .where(eq(member.organizationId, picks.organization));
    return db
      .select({ id: user.id, name: user.name })
      .from(user)
      .where(inArray(user.id, seated))
      .orderBy(asc(user.id));
  },
  notExists: (db, picks) => {
    const seat = inviterSeat(db);
    return db
      .select({ id: teamInvitations.id })
      .from(teamInvitations)
      .where(and(eq(teamInvitations.organizationId, picks.organization), notExists(seat)))
      .orderBy(asc(teamInvitations.id));
  },
  notInSubquery: (db, picks) => {
    const seated = db
      .select({ id: member.userId })
      .from(member)
      .where(eq(member.organizationId, picks.organization));
    return db
      .select({ id: user.id, name: user.name })
      .from(user)
      .where(notInArray(user.id, seated))
      .orderBy(asc(user.id));
  },
  orderedBySubquery: (db, picks) => {
    return db
      .select({ id: member.id, name: user.name })
      .from(member)
      .innerJoin(user, eq(user.id, member.userId))
      .where(eq(member.organizationId, picks.organization))
      .orderBy(
        sql`(select count(*) from ${teamInvitations} where ${teamInvitations.inviterUserId} = ${user.id})`,
        asc(member.id),
      );
  },
  relationalMany: (db, picks) => {
    return db.query.organization.findFirst({
      where: eq(organization.id, picks.organization),
      with: { members: { with: { user: true } } },
    });
  },
  relationalOne: (db, picks) => {
    return db.query.member.findMany({
      limit: PAGE.rows,
      where: eq(member.organizationId, picks.organization),
      with: { organization: true, user: true },
    });
  },
  // A `SELECT` as a condition, in a fragment: Drizzle's `and` writes parentheses of its own.
  scalarCondition: (db, picks) => {
    const asked = sql`${eq(user.id, picks.user)} and ${eq(member.organizationId, picks.organization)}`;
    return db
      .select({ id: member.id })
      .from(member)
      .where(sql`(select count(*) = 0 from ${user} where ${asked})`)
      .orderBy(asc(member.id));
  },
  scalar: (db, picks) => {
    return db
      .select({
        id: organization.id,
        seats: sql<number>`(select count(*) from ${member} where ${member.organizationId} = ${organization.id})`,
      })
      .from(organization)
      .where(eq(organization.slug, picks.slug));
  },
  shadowedAlias: (db, picks) => {
    const mine = alias(member, 'mine');
    const seated = db
      .select({ id: mine.id })
      .from(mine)
      .where(and(eq(mine.organizationId, member.organizationId), eq(mine.userId, picks.user)));
    return db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.organizationId, picks.organization), exists(seated)))
      .orderBy(asc(member.id));
  },
  unionAll: (db, picks) => {
    return db
      .select({ id: member.id })
      .from(member)
      .where(eq(member.organizationId, picks.organization))
      .unionAll(db.select({ id: user.id }).from(user).where(eq(user.githubId, picks.github)));
  },
};

const written: Readonly<Record<string, Shape>> = {
  andInCase: (db, picks) => {
    return db.all(sql`
      select "m"."id" from "member" "m" inner join "user" "u" on "u"."id" = "m"."user_id"
      where case when 1 and "m"."organization_id" = ${picks.organization} and 1
        then 1 else "m"."role" = 'owner' end
      order by "m"."id"`);
  },
  between: (db, picks) => {
    return db.all(sql`
      select "m"."id" from "member" "m" inner join "user" "u" on "u"."id" = "m"."user_id"
      where "m"."created_at" between 1 and 2 and "m"."organization_id" = ${picks.organization}
      order by "m"."id"`);
  },
  caseWhen: (db, picks) => {
    return db.all(sql`
      select "m"."id" from "member" "m" inner join "user" "u" on "u"."id" = "m"."user_id"
      where case when "m"."organization_id" = ${picks.organization} and "m"."role" = 'owner'
        then 1 else "m"."user_id" = ${picks.user} end
      order by "m"."id"`);
  },
  comma: (db, picks) => {
    return db.all(sql`
      select "m"."id" as a, "o"."id" as b from "member" "m", "organization" "o"
      where "m"."organization_id" = ${picks.organization} and "o"."id" = "m"."organization_id"
      order by "m"."id"`);
  },
  cross: (db, picks) => {
    return db.all(sql`
      select "m"."id" as a, "o"."id" as b from "member" "m" cross join "organization" "o"
      where "m"."organization_id" = ${picks.organization} and "o"."id" = "m"."organization_id"
      order by "m"."id"`);
  },
  distinctFrom: (db, picks) => {
    return db.all(sql`
      select "m"."id" from "member" "m" inner join "user" "u" on "u"."id" = "m"."user_id"
      where "m"."organization_id" = ${picks.organization}
        and "u"."github_id" is not distinct from ${picks.github} or "m"."role" = 'owner'
      order by "m"."id"`);
  },
  existsInOn: (db, picks) => {
    return db.all(sql`
      select "u"."id" as a, "m"."id" as b from "user" "u"
      left join "member" "m" on "m"."user_id" = "u"."id" and exists (
        select 1 from "organization" "o"
        where "o"."id" = "m"."organization_id" and "o"."slug" = ${picks.slug})
      where "u"."id" = ${picks.user} order by "m"."id"`);
  },
  foldedAlias: (db, picks) => {
    return db.all(sql`
      select "m"."id" from "member" "m" where "m"."organization_id" = ${picks.organization}
      and exists (select 1 from "member" "M"
        where "M"."organization_id" = "m"."organization_id" and "M"."user_id" = ${picks.user})
      order by "m"."id"`);
  },
  functionArgument: (db, picks) => {
    return db.all(sql`
      select "u"."id", (
        select group_concat("j"."value") from json_each((
          select json_group_array("m"."role") from "member" "m"
          where "m"."organization_id" = "u"."id"
        )) "j" inner join "organization" "u" on "u"."id" = ${picks.organization}
      ) from "user" "u" where "u"."id" = ${picks.user}`);
  },
  isEqual: (db, picks) => {
    return db.all(sql`
      select "m"."id" from "member" "m" left join "user" "u" on "u"."id" is "m"."user_id"
      where "m"."organization_id" = ${picks.organization} order by "m"."id"`);
  },
  leftThreeWords: (db, picks) => {
    return db.all(sql`
      select "m"."id" as a, "o"."id" as b from "user" "u"
      inner join "member" "m" on "m"."user_id" = "u"."id"
      left outer outer join "organization" "o"
        on "o"."id" = "m"."organization_id" and "m"."organization_id" = ${picks.organization}
      order by 1, 2`);
  },
  levelOfAnotherAffinity: (db) => {
    return db.all(sql`
      select "m"."id" as a, "u"."id" as b from "member" "m"
      inner join "user" "u" on "u"."level" = "m"."level"
      where "m"."level" = ${'1'} order by 1, 2`);
  },
  leftNull: (db, picks) => {
    return db.all(sql`
      select "m"."id" from "member" "m" left join "user" "u" on "u"."id" = "m"."user_id"
      where "u"."id" is null and "m"."organization_id" = ${picks.organization}
      order by "m"."id"`);
  },
  negated: (db, picks) => {
    return db.all(sql`
      select "m"."id" from "member" "m" inner join "user" "u" on "u"."id" = "m"."user_id"
      where not "m"."organization_id" = ${picks.organization} order by "m"."id"`);
  },
  notExistsOfOuter: (db, picks) => {
    return db.all(sql`
      select "m"."id" from "member" "m" where not exists (
        select 1 from "team_invitations" "i"
        where "i"."organization_id" = ${picks.organization}
          and "i"."organization_id" = "m"."organization_id")
      order by "m"."id"`);
  },
  orAfterAnd: (db, picks) => {
    return db.all(sql`
      select "m"."id" from "member" "m" inner join "user" "u" on "u"."id" = "m"."user_id"
      where "m"."organization_id" = ${picks.organization} and "m"."role" = 'owner'
        or "m"."user_id" = ${picks.user}
      order by "m"."id"`);
  },
  orInOn: (db, picks) => {
    return db.all(sql`
      select "m"."id" as a, "u"."id" as b from "member" "m"
      left join "user" "u" on "u"."id" = "m"."user_id" or "u"."github_id" = ${picks.github}
      where "m"."organization_id" = ${picks.organization} order by "m"."id", "u"."id"`);
  },
  rightJoin: (db, picks) => {
    return db.all(sql`
      select "m"."id" as a, "u"."id" as b from "member" "m"
      right join "user" "u" on "u"."id" = "m"."user_id"
        and "m"."organization_id" = ${picks.organization}
      order by "u"."id", "m"."id"`);
  },
  scalarByParameter: (db, picks) => {
    return db.all(sql`
      select "o"."id", (select count(*) from "member" "m"
        where "m"."organization_id" = "o"."id" and "m"."user_id" = ${picks.user})
      from "organization" "o" where "o"."id" = ${picks.organization}`);
  },
};

/** Every statement of the oracle, by a name a finding reads by. */
export const SHAPES: Readonly<Record<string, Shape>> = {
  ...joins,
  ...Object.fromEntries(Object.entries(leftJoins).map(([name, each]) => [`left ${name}`, each])),
  ...Object.fromEntries(Object.entries(subqueries).map(([name, each]) => [`nested ${name}`, each])),
  ...Object.fromEntries(Object.entries(written).map(([name, each]) => [`written ${name}`, each])),
};
