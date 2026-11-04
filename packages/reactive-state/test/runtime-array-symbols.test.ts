/* eslint sonarjs/no-empty-test-file: "off" -- Imported registration keeps the identical suite in both runtimes; Sonar only checks local test calls. */
import { runtimeArraySymbols } from './support/runtime-array-symbols.ts';

// eslint-disable-next-line vitest/require-hook -- This call registers the imported test suites.
runtimeArraySymbols();
