#!/usr/bin/env node
import { repairNodePtySpawnHelpers } from './node-pty-permissions.mjs';

repairNodePtySpawnHelpers({ log: true });
