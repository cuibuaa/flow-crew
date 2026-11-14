import {createHash} from 'node:crypto';
import type {BuildManifest} from '../../src/build-manifest.js';

// Construct an honestly attested foreign/legacy manifest, rather than treating
// a tampered declaration as a compatibility test.
export function reattestCompatibility(manifest: BuildManifest, compatibility: string | undefined): BuildManifest {
  const next=structuredClone(manifest); delete next.controlCompatibility;
  if (compatibility !== undefined) next.controlCompatibility=compatibility;
  const digest=(records: BuildManifest['outputs'])=>createHash('sha256').update(records.map(r=>`${Buffer.byteLength(r.path)}:${r.path}:${r.bytes}:${r.sha256}\n`).join('')).digest('hex');
  next.generation=createHash('sha256').update(`${next.inputs.hash}\n${digest(next.outputs)}`
    +(next.ui ? `\nui:${digest(next.ui.outputs)}`:'')
    +(next.uiPresence ? `\nui-presence:${next.uiPresence}`:'')
    +(next.artifacts ? `\nartifacts:${digest(next.artifacts.backend)}:${digest(next.artifacts.ui)}`:'')
    +(compatibility !== undefined ? `\ncontrol-compatibility:${compatibility}`:'')).digest('hex');
  return next;
}

