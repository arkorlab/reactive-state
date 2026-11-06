/* eslint sonarjs/no-empty-test-file: "off" -- Original test cases are registered by the shared suite. */
import { carriedArrayUndefinedChecks } from './support/carried-array-undefined.ts';

// eslint-disable-next-line vitest/require-hook -- This call registers the original shared tests.
carriedArrayUndefinedChecks();
