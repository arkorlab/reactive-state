/* eslint sonarjs/no-empty-test-file: "off" -- Imported registration shares the identical suite across Node and Workers. */
import { requestViewContainers } from './support/request-view-containers.ts';

// eslint-disable-next-line vitest/require-hook -- This call registers the imported test suite.
requestViewContainers();
