/**
 * Worker thread for parallel comparison-based sort.
 *
 * Communicates via SharedArrayBuffer + Atomics. Commands:
 *   1 = count bucket histogram for assigned input chunk
 *   2 = scatter to output buckets, barrier, then sort assigned buckets
 *  -1 = shutdown
 */
import { workerData } from 'node:worker_threads';

const {
  inputSab, outputSab, controlSab, countsSab, bucketInfoSab,
  workerId, numBuckets, bucketShift, numWorkers,
} = workerData;

const input = new Int32Array(inputSab);
const output = new Int32Array(outputSab);
const control = new Int32Array(controlSab);
const allCounts = new Int32Array(countsSab);
const bucketInfo = new Int32Array(bucketInfoSab);
const BASE = workerId * 4;
const countBase = workerId * numBuckets;
const localOffsets = new Int32Array(numBuckets);
const BARRIER_IDX = numWorkers * 4;
const bucketsPerWorker = numBuckets / numWorkers;

for (;;) {
  Atomics.wait(control, BASE, 0);
  const cmd = Atomics.load(control, BASE);
  if (cmd === -1) break;

  const chunkStart = control[BASE + 1];
  const chunkEnd = control[BASE + 2];

  if (cmd === 1) {
    for (let b = 0; b < numBuckets; b++) allCounts[countBase + b] = 0;
    for (let i = chunkStart; i < chunkEnd; i++) {
      allCounts[countBase + ((input[i] ^ -2147483648) >>> bucketShift)]++;
    }
  } else if (cmd === 2) {
    for (let b = 0; b < numBuckets; b++) localOffsets[b] = allCounts[countBase + b];
    for (let i = chunkStart; i < chunkEnd; i++) {
      const v = input[i];
      output[localOffsets[(v ^ -2147483648) >>> bucketShift]++] = v;
    }
    Atomics.add(control, BARRIER_IDX, 1);
    while (Atomics.load(control, BARRIER_IDX) < numWorkers) { /* spin */ }
    const firstBucket = control[BASE + 3];
    const lastBucket = firstBucket + bucketsPerWorker;
    for (let b = firstBucket; b < lastBucket; b++) {
      const start = bucketInfo[b * 2];
      const end = bucketInfo[b * 2 + 1];
      if (end > start) output.subarray(start, end).sort();
    }
  }

  Atomics.store(control, BASE, 0);
  Atomics.notify(control, BASE);
}

process.exit(0);
