import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDistFresh } from '../src/build-manifest.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default function verifyTestRuntimeGeneration(): void {
  assertDistFresh(projectRoot);
}
