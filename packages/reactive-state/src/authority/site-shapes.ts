import type { GateRequest, SiteShape } from '../routing.ts';
import { PLAIN_SITE, sameSite } from '../site-paths.ts';
import type { SharedStore } from './shared-store.ts';

/**
 * Where the site serves its routes — under which base path, in which trailing-slash form — as
 * whoever knows it said: the build's, and each deployment's. Deployments a site serves at once may
 * serve their routes otherwise, each by the `next.config` it was built with: a gate's question is
 * read as it says itself, whatever another said meanwhile, and a view's artifacts are asked for where
 * the site of the question that asked for it serves its page (`Entry.site`).
 */

/**
 * The deployments whose sites are kept, as their questions said them: the latest few, which a site
 * serves at once while one replaces another; the one heard from longest ago is let go of.
 */
const MAX_DEPLOYMENT_SITES = 16;

export class SiteShapes {
  readonly #store: SharedStore;
  readonly #build: string;
  /**
   * The build's, as whoever knows it said last: the host that told the authority its site (`told`),
   * the application's server with a gate's question, or a page's render (`learn`). None before one
   * did, when the site is read as serving each route at its own path — a request of a path it does
   * not serve so passes, and the page's render that answers it says.
   */
  #site: SiteShape | undefined;
  /** Each deployment's, as its gate's questions said, by deployment. */
  readonly #deployments = new Map<string, SiteShape>();

  constructor(store: SharedStore, build: string) {
    this.#store = store;
    this.#build = build;
  }

  /** `deployment`'s, as a question of it says: kept for what of it says nothing (`said`). */
  #heard(deployment: string, site: SiteShape): void {
    this.#deployments.delete(deployment);
    this.#deployments.set(deployment, site);
    const [oldest] = this.#deployments.keys();
    if (oldest !== undefined && this.#deployments.size > MAX_DEPLOYMENT_SITES) {
      this.#deployments.delete(oldest);
    }
  }

  /** The build's, as its pages said before the authority started (`learn`). */
  load(): void {
    this.#site = this.#store.site(this.#build);
  }

  /**
   * The build's, as the host that told the authority its site says — from the build it serves, which
   * the edge's question says nothing of: held from now on, in place of what was learned before, and
   * learned again of whatever says otherwise after it.
   */
  told(site: SiteShape): void {
    this.#site = site;
  }

  /**
   * Where the site serves its routes, as a gate's question says: kept for its deployment at once, and
   * for the build in the queue (`run`), which the store is written in, where it says something new
   * of it. The question itself is read as it says, whatever another said meanwhile (`said`).
   */
  async heed(
    request: Pick<GateRequest, 'deployment' | 'site'>,
    run: (body: () => void) => Promise<void>,
  ): Promise<void> {
    const { deployment, site } = request;
    if (site === undefined) {
      return;
    }
    if (deployment !== undefined) {
      this.#heard(deployment, site);
    }
    if (!sameSite(this.#site, site)) {
      await run(() => {
        this.learn(site);
      });
    }
  }

  /** In the queue: the build's, as a page's render or a gate's question says — kept from now on. */
  learn(site: SiteShape | undefined): void {
    if (site === undefined || sameSite(this.#site, site)) {
      return;
    }
    this.#site = site;
    this.#store.putSite(this.#build, site);
  }

  /**
   * Where the site serves its routes for `request`, where something said it: as it says itself; else
   * as its deployment's questions said. None where neither did, which the build's stands in for.
   */
  said(request: Pick<GateRequest, 'deployment' | 'site'>): SiteShape | undefined {
    const { deployment, site } = request;
    return site ?? (deployment === undefined ? undefined : this.#deployments.get(deployment));
  }

  /** `site`, where there is one; else the build's. */
  orBuild(site: SiteShape | undefined): SiteShape {
    return site ?? this.#site ?? PLAIN_SITE;
  }
}
