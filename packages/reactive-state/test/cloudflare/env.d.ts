import type { AuthorityEnv, AuthorityObject } from '../../src/cloudflare/index.ts';
import type * as worker from './worker.ts';

declare global {
  namespace Cloudflare {
    /** What the suites' Miniflare binds (`vitest.workers.config.mts`): the object, and its site. */
    interface Env extends AuthorityEnv {
      readonly AUTHORITY: DurableObjectNamespace<AuthorityObject>;
      /** The object of the application that shares no view (`UnsharedAuthority`). */
      readonly UNSHARED: DurableObjectNamespace<AuthorityObject>;
      /** The object of the application that signs its users in itself (`AssertedAuthority`). */
      readonly ASSERTED: DurableObjectNamespace<AuthorityObject>;
      /** The object that reads the application's external database. */
      readonly EXTERNAL_AUTHORITY: DurableObjectNamespace<AuthorityObject>;
      /** The object whose states bind rows of the application's D1. */
      readonly D1_ROWS_AUTHORITY: DurableObjectNamespace<AuthorityObject>;
      /** The object of the test application that knows no site (`SitelessAuthority`). */
      readonly SITELESS: DurableObjectNamespace<AuthorityObject>;
      /** The object of an application of one call (`ZeroConfigAuthority`). */
      readonly ZERO_CONFIG: DurableObjectNamespace<AuthorityObject>;
      /** The same, of a log that takes a while to make (`SlowStartAuthority`). */
      readonly SLOW_START: DurableObjectNamespace<AuthorityObject>;
      /** The same, of a log whose making never ends (`HungStartAuthority`). */
      readonly HUNG_START: DurableObjectNamespace<AuthorityObject>;
      /** The same, whose storage fails to arm its first alarm as it starts (`ArmFailsAuthority`). */
      readonly ARM_FAILS: DurableObjectNamespace<AuthorityObject>;
      /** The object whose render fault its `onError` reports (`ReportingAuthority`). */
      readonly REPORTING: DurableObjectNamespace<AuthorityObject>;
      /** The application's own D1, with trigger-based change capture. */
      readonly REACTIVE_D1: D1Database;
    }
    /** The suites' Worker, as `exports` from `cloudflare:workers` reaches it. */
    interface GlobalProps {
      mainModule: typeof worker;
    }
  }
}
