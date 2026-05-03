/**
 * Ultra-fast LSD radix sort (base-256) for 32-bit integers.
 *
 * Performs 4 counting-sort passes (one per byte, least-significant first) on an
 * {@link Int32Array}. Negative numbers are handled by flipping the sign bit in
 * the most-significant-byte pass so they sort before positives.
 *
 * Uses module-level pre-allocated buffers to eliminate allocation/GC overhead.
 *
 * Complexity: O(4n) time, O(n + 1024) space.
 *
 * @module
 */

// Pre-allocated module-level buffers — reused across calls (safe: Node.js is single-threaded)
let _scratch: Int32Array | null = null;
let _scratchLen = 0;
let _cmpScratch: Int32Array | null = null;
let _cmpScratchLen = 0;
const _c0 = new Uint32Array(256);
const _c1 = new Uint32Array(256);
const _c2 = new Uint32Array(256);
const _c3 = new Uint32Array(256);

/**
 * Sorts a regular number array and returns a new sorted array.
 *
 * @param arr - Array of 32-bit integers.
 * @returns A new sorted array in ascending order.
 */
export function fastSort(arr: number[]): number[] {
  const n = arr.length;
  if (n <= 1) return arr.slice();
  const typed = new Int32Array(n);
  for (let i = 0; i < n; i++) typed[i] = arr[i];
  fastSortInPlace(typed);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = typed[i];
  return out;
}

/**
 * Sorts an {@link Int32Array} in place using LSD radix sort (base-256).
 *
 * All 4 histogram counts are computed in a single scan, then each pass
 * scatters using its pre-computed prefix sums. The final pass flips bit 7
 * of the MSB so that negative values sort before positives.
 *
 * @param arr - Typed array to sort in place.
 * @returns The same array reference, now sorted in ascending order.
 */
export function fastSortInPlace(arr: Int32Array): Int32Array {
  const n = arr.length;
  if (n <= 1) return arr;

  if (n > _scratchLen) {
    _scratch = new Int32Array(n);
    _scratchLen = n;
  }
  const scratch = _scratch!;
  const c0 = _c0;
  const c1 = _c1;
  const c2 = _c2;
  const c3 = _c3;

  c0.fill(0);
  c1.fill(0);
  c2.fill(0);
  c3.fill(0);

  // Build all 4 histograms in a single pass
  for (let i = 0; i < n; i++) {
    const v = arr[i];
    c0[v & 0xff]++;
    c1[(v >>> 8) & 0xff]++;
    c2[(v >>> 16) & 0xff]++;
    c3[((v >>> 24) & 0xff) ^ 0x80]++;
  }

  // Convert counts to prefix sums
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  for (let i = 0; i < 256; i++) {
    let t: number;
    t = c0[i]; c0[i] = s0; s0 += t;
    t = c1[i]; c1[i] = s1; s1 += t;
    t = c2[i]; c2[i] = s2; s2 += t;
    t = c3[i]; c3[i] = s3; s3 += t;
  }

  // Pass 0: byte 0 (LSB), arr → scratch
  for (let i = 0; i < n; i++) {
    const v = arr[i];
    scratch[c0[v & 0xff]++] = v;
  }

  // Pass 1: byte 1, scratch → arr
  for (let i = 0; i < n; i++) {
    const v = scratch[i];
    arr[c1[(v >>> 8) & 0xff]++] = v;
  }

  // Pass 2: byte 2, arr → scratch
  for (let i = 0; i < n; i++) {
    const v = arr[i];
    scratch[c2[(v >>> 16) & 0xff]++] = v;
  }

  // Pass 3: byte 3 (MSB) with sign-bit flip, scratch → arr
  for (let i = 0; i < n; i++) {
    const v = scratch[i];
    arr[c3[((v >>> 24) & 0xff) ^ 0x80]++] = v;
  }

  return arr;
}

/**
 * Comparison-based sort using V8's native Int32Array.sort() (Timsort in C++).
 *
 * @param arr - Array of 32-bit integers.
 * @returns A new sorted array in ascending order.
 */
export function fastComparisonSort(arr: number[]): number[] {
  const n = arr.length;
  if (n <= 1) return arr.slice();
  if (n > _cmpScratchLen) {
    _cmpScratch = new Int32Array(n);
    _cmpScratchLen = n;
  }
  const typed = _cmpScratch!;
  for (let i = 0; i < n; i++) typed[i] = arr[i];
  const view = typed.subarray(0, n);
  view.sort();
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = view[i];
  return out;
}

/**
 * Comparison-based in-place sort using V8's native Int32Array.sort().
 *
 * @param arr - Typed array to sort in place.
 * @returns The same array reference, now sorted in ascending order.
 */
export function fastComparisonSortInPlace(arr: Int32Array): Int32Array {
  return arr.sort();
}

// ---------------------------------------------------------------------------
// Parallel comparison-based sort using Worker threads + SharedArrayBuffer
// ---------------------------------------------------------------------------

import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';

const NUM_BUCKETS = 4096;
const BUCKET_SHIFT = 20; // top 12 bits of sign-flipped value

/** Maximum array size the pre-allocated shared buffers support. */
const MAX_N = 2_000_000;

let _pool: SortWorkerPool | null = null;
let _poolInitPromise: Promise<SortWorkerPool> | null = null;

interface SortWorkerPool {
  numWorkers: number;
  workers: Worker[];
  input: Int32Array;
  output: Int32Array;
  control: Int32Array;
  allCounts: Int32Array;
  bucketInfo: Int32Array;
  localCounts: Int32Array;
}

function createPool(): Promise<SortWorkerPool> {
  const numWorkers = Math.min(availableParallelism(), 8);
  const workerUrl = new URL('./sort-worker.mjs', import.meta.url);

  const inputSab = new SharedArrayBuffer(MAX_N * 4);
  const outputSab = new SharedArrayBuffer(MAX_N * 4);
  const controlSab = new SharedArrayBuffer((numWorkers * 4 + 4) * 4);
  const countsSab = new SharedArrayBuffer(numWorkers * NUM_BUCKETS * 4);
  const bucketInfoSab = new SharedArrayBuffer(NUM_BUCKETS * 2 * 4);

  const input = new Int32Array(inputSab);
  const output = new Int32Array(outputSab);
  const control = new Int32Array(controlSab);
  const allCounts = new Int32Array(countsSab);
  const bucketInfo = new Int32Array(bucketInfoSab);
  const localCounts = new Int32Array(numWorkers * NUM_BUCKETS);

  const workers: Worker[] = [];
  const readyPromises: Promise<void>[] = [];

  for (let i = 0; i < numWorkers; i++) {
    const w = new Worker(workerUrl, {
      workerData: {
        inputSab, outputSab, controlSab, countsSab, bucketInfoSab,
        workerId: i, numBuckets: NUM_BUCKETS, bucketShift: BUCKET_SHIFT, numWorkers,
      },
    });
    workers.push(w);
    readyPromises.push(new Promise<void>((resolve) => {
      // Worker is ready once it starts (enters its first Atomics.wait)
      // Give a small delay for the worker to initialize
      setTimeout(resolve, 50);
    }));
  }

  return Promise.all(readyPromises).then(() => ({
    numWorkers, workers, input, output, control, allCounts, bucketInfo, localCounts,
  }));
}

async function getPool(): Promise<SortWorkerPool> {
  if (_pool) return _pool;
  if (!_poolInitPromise) {
    _poolInitPromise = createPool().then((p) => { _pool = p; return p; });
  }
  return _poolInitPromise;
}

/** Eagerly warm up the worker pool. Call early to amortize startup cost. */
export async function warmupSortWorkers(): Promise<void> {
  await getPool();
}

function poolWaitAll(pool: SortWorkerPool): void {
  const { control, numWorkers } = pool;
  for (let i = 0; i < numWorkers; i++) {
    const BASE = i * 4;
    const v = Atomics.load(control, BASE);
    if (v !== 0) Atomics.wait(control, BASE, v);
  }
}

function poolDispatchSort(pool: SortWorkerPool, n: number): void {
  const { control, allCounts, bucketInfo, numWorkers } = pool;
  const chunkSize = Math.ceil(n / numWorkers);
  const bucketsPerWorker = NUM_BUCKETS / numWorkers;

  // Set per-worker params
  for (let i = 0; i < numWorkers; i++) {
    const BASE = i * 4;
    control[BASE + 1] = i * chunkSize;
    control[BASE + 2] = Math.min((i + 1) * chunkSize, n);
    control[BASE + 3] = i * bucketsPerWorker;
  }

  // Phase 1: Parallel count
  for (let i = 0; i < numWorkers; i++) {
    Atomics.store(control, i * 4, 1);
    Atomics.notify(control, i * 4);
  }
  poolWaitAll(pool);

  // Compute bucket offsets and per-worker scatter positions.
  // Copy counts to a local (non-shared) array for faster access.
  const { localCounts } = pool;
  localCounts.set(allCounts);
  let pos = 0;
  for (let b = 0; b < NUM_BUCKETS; b++) {
    let total = 0;
    for (let w = 0; w < numWorkers; w++) total += localCounts[w * NUM_BUCKETS + b];
    bucketInfo[b * 2] = pos;
    const bStart = pos;
    pos += total;
    bucketInfo[b * 2 + 1] = pos;
    let off = bStart;
    for (let w = 0; w < numWorkers; w++) {
      const c = localCounts[w * NUM_BUCKETS + b];
      allCounts[w * NUM_BUCKETS + b] = off;
      off += c;
    }
  }

  // Phase 2: Parallel scatter + sort
  Atomics.store(control, numWorkers * 4, 0); // reset barrier
  for (let i = 0; i < numWorkers; i++) {
    Atomics.store(control, i * 4, 2);
    Atomics.notify(control, i * 4);
  }
  poolWaitAll(pool);
}

/**
 * Parallel comparison-based sort of an Int32Array.
 * Uses Worker threads with SharedArrayBuffer for zero-copy parallelism.
 * Each bucket is sorted with V8's native Timsort (comparison-based).
 *
 * @param arr - Typed array to sort. Not modified.
 * @returns A new sorted Int32Array in ascending order.
 */
export async function parallelComparisonSortInPlace(arr: Int32Array): Promise<Int32Array> {
  const n = arr.length;
  if (n <= 1) return arr;

  // Fall back to single-threaded sort for small arrays or if SharedArrayBuffer unavailable
  if (n < 100_000 || typeof SharedArrayBuffer === 'undefined') {
    return arr.sort();
  }

  const pool = await getPool();
  pool.input.set(arr);
  poolDispatchSort(pool, n);

  // Copy result back to caller's array
  arr.set(pool.output.subarray(0, n));
  return arr;
}

/**
 * Parallel comparison-based sort of a number array.
 *
 * @param arr - Array of 32-bit integers.
 * @returns A new sorted array in ascending order.
 */
export async function parallelComparisonSort(arr: number[]): Promise<number[]> {
  const n = arr.length;
  if (n <= 1) return arr.slice();

  if (n < 100_000 || typeof SharedArrayBuffer === 'undefined') {
    return fastComparisonSort(arr);
  }

  const pool = await getPool();
  const input = pool.input;
  for (let i = 0; i < n; i++) input[i] = arr[i];
  poolDispatchSort(pool, n);

  const out = new Array<number>(n);
  const output = pool.output;
  for (let i = 0; i < n; i++) out[i] = output[i];
  return out;
}

/**
 * Cleanly terminate the worker pool. Call when done sorting.
 */
export async function shutdownSortWorkers(): Promise<void> {
  if (!_pool) return;
  const pool = _pool;
  _pool = null;
  _poolInitPromise = null;
  for (let i = 0; i < pool.numWorkers; i++) {
    Atomics.store(pool.control, i * 4, -1);
    Atomics.notify(pool.control, i * 4);
  }
  await Promise.all(pool.workers.map((w) => new Promise<void>((r) => w.on('exit', r))));
}
