/**
 * The checks a Durable Object owes the public pages of deployments it had not heard from
 * (`delivery.ts`), and the answers that do them. The project's hostname serves the deployment
 * before a new one until the switch reaches every location, and the cache is each deployment's
 * own, so a check is done by the answers of the deployment it is owed to alone: the changes
 * route's (`{ deployment }`) and the page's (`data-deployment`) say which deployment gave them. A
 * check is done page by page: a page whose part is done is not checked again for it, however long
 * another page's part takes.
 */

/** A check owed to a deployment the object had not heard from, done by its answers alone. */
export interface OwedCheck {
  /** The deployment the check is owed to, whose answers alone do it. */
  readonly deployment: string;
  /** When the object first heard from the deployment. */
  readonly at: number;
  /** The paths of the pages whose part of it is done. */
  readonly pages: readonly string[];
}

/**
 * The checks owed, as the object keeps them (`catch_up_fresh`), oldest first: each deployment,
 * when it was heard from, and the pages whose part is done. What holds anything else is no check.
 */
export function owedChecks(value: string | undefined): readonly OwedCheck[] {
  let owed: unknown;
  try {
    owed = value === undefined ? [] : JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(owed)) {
    return [];
  }
  return owed.flatMap((item: unknown) => {
    const { at, deployment, pages } = (item ?? {}) as Readonly<Partial<Record<string, unknown>>>;
    return typeof at === 'number' && typeof deployment === 'string' && Array.isArray(pages)
      ? [{ at, deployment, pages: pages.filter((page) => typeof page === 'string') }]
      : [];
  });
}

/** Whether two checks are one: owed to one deployment, from one time. */
function sameCheck(a: OwedCheck, b: OwedCheck): boolean {
  return a.deployment === b.deployment && a.at === b.at;
}

/** The deployment that answered a page's check owed to new ones: the first that an answer named. */
export interface Answering {
  /** The checks the page's part of was made for. */
  readonly owed: readonly OwedCheck[];
  deployment: string | undefined;
}

/**
 * The checks a page's part of which `answering` did: those of the deployment that answered it — all
 * of them where no answer named a deployment, as an application that names none has them done.
 */
export function doneBy(answering: Answering): readonly OwedCheck[] {
  const answered = answering.deployment;
  return answering.owed.filter((check) => answered === undefined || check.deployment === answered);
}

/** A page's part of a check, done. */
export interface PageDone {
  readonly check: OwedCheck;
  readonly path: string;
}

/**
 * The checks owed still, of those the object keeps (`kept`) once the parts in `done` are: a check
 * whose every page of `paths` is done is settled, and one owed for longer than `maxAgeMs` given up.
 */
export function owedStill(
  kept: readonly OwedCheck[],
  done: readonly PageDone[],
  paths: readonly string[],
  limits: { readonly now: number; readonly maxAgeMs: number },
): readonly OwedCheck[] {
  return kept.flatMap((check) => {
    if (limits.now - check.at > limits.maxAgeMs) {
      return [];
    }
    const pages = new Set(check.pages);
    for (const part of done) {
      if (sameCheck(part.check, check)) {
        pages.add(part.path);
      }
    }
    return paths.every((path) => pages.has(path)) ? [] : [{ ...check, pages: [...pages] }];
  });
}

/** Whether `deployment`'s pages are owed a check of their own. */
export function isOwed(answering: Answering, deployment: string): boolean {
  return answering.owed.some((check) => check.deployment === deployment);
}

/**
 * Notes the deployment an answer to a check owed to new ones names, if it names one; one that names
 * another than an answer before it fails the check, which no deployment answered whole.
 */
export function noteAnswer(
  answering: Answering | undefined,
  answered: string | undefined,
  where: string,
): void {
  if (answering === undefined || answered === undefined) {
    return;
  }
  if (answering.deployment === undefined) {
    answering.deployment = answered;
  } else if (answered !== answering.deployment) {
    throw new Error(
      `${where}: answered by ${answered}, after ${answering.deployment} answered the same check`,
    );
  }
}
