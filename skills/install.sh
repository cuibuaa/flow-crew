#!/bin/bash
# Install FlowCrew skills for Claude Code and/or Codex.
# Usage: ./install.sh [--claude] [--codex] [--global|--project]

set -e

usage() {
  printf '%s\n' 'Usage: ./install.sh [--claude] [--codex] [--global|--project]'
  printf '%s\n' ''
  printf '%s\n' '  --claude   Install /ship and /fc-status for Claude Code'
  printf '%s\n' '  --codex    Install ship and fc-status skills for Codex'
  printf '%s\n' '  --global   Install to user-level agent directories'
  printf '%s\n' '  --project  Install to project-level agent directories'
  printf '%s\n' ''
  printf '%s\n' 'Default: consider both agents and install only those whose CLI is on PATH.'
}

SCRIPT_PATH="${BASH_SOURCE[0]}"
case "$SCRIPT_PATH" in
  /*) ;;
  *) SCRIPT_PATH="$PWD/$SCRIPT_PATH" ;;
esac
SCRIPT_DIR="${SCRIPT_PATH%/*}"
SCRIPT_DIR="$(cd "$SCRIPT_DIR" && pwd -P)"

INSTALL_CLAUDE=false
INSTALL_CODEX=false
GLOBAL=true

for arg in "$@"; do
  case "$arg" in
    --claude) INSTALL_CLAUDE=true ;;
    --codex) INSTALL_CODEX=true ;;
    --global) GLOBAL=true ;;
    --project) GLOBAL=false ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n\n' "$arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# With no agent selector, consider both. Presence is still checked below.
if ! $INSTALL_CLAUDE && ! $INSTALL_CODEX; then
  INSTALL_CLAUDE=true
  INSTALL_CODEX=true
fi

if $GLOBAL && [ -z "${HOME:-}" ]; then
  printf '%s\n' 'Cannot install user-level skills because HOME is not set.' >&2
  exit 1
fi

copy_and_verify() {
  local source_file="$1"
  local target_file="$2"
  local target_dir="${target_file%/*}"
  mkdir -p "$target_dir"
  cp "$source_file" "$target_file"
  if ! cmp -s "$source_file" "$target_file"; then
    printf 'Installed file did not match its source: %s\n' "$target_file" >&2
    return 1
  fi
}

verify_codex_enumeration() {
  local codex_bin="$1"
  local ship_path="$2"
  local status_path="$3"
  local node_bin="${FLOWCREW_NODE:-}"
  local timeout_ms="${FLOWCREW_CODEX_VERIFY_TIMEOUT_MS:-20000}"
  if [ -z "$node_bin" ]; then
    if ! node_bin="$(command -v node 2>/dev/null)"; then
      printf '%s\n' 'Codex verification requires Node.js, but node was not found on PATH.' >&2
      return 1
    fi
  fi
  case "$timeout_ms" in
    ''|*[!0-9]*|0)
      printf '%s\n' 'FLOWCREW_CODEX_VERIFY_TIMEOUT_MS must be a positive integer.' >&2
      return 1
      ;;
  esac

  "$node_bin" --input-type=module - "$codex_bin" "$PWD" "$ship_path" "$status_path" "$timeout_ms" <<'NODE'
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const [codexBin, cwd, shipPath, statusPath, timeoutArg] = process.argv.slice(2);
const timeoutMs = Number.parseInt(timeoutArg, 10);
const timeoutLabel = timeoutMs % 1_000 === 0 ? `${timeoutMs / 1_000} seconds` : `${timeoutMs} ms`;
try {
  const child = spawn(codexBin, ['app-server'], {
    cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const listed = await new Promise((resolveList, reject) => {
    let buffer = '';
    let stderr = '';
    let answer;
    let settled = false;
    let shutdownTimer;
    let forceKillTimer;
    let detachTimer;
    let stopping = false;
    let stopError;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(shutdownTimer);
      clearTimeout(forceKillTimer);
      clearTimeout(detachTimer);
      if (error) reject(error);
      else resolveList(answer);
    };
    const stopChild = (error) => {
      if (settled || stopping) return;
      stopping = true;
      stopError = error;
      child.stdin.end();
      child.kill('SIGTERM');
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        child.kill('SIGKILL');
        detachTimer = setTimeout(() => {
          if (settled) return;
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          finish(stopError || new Error('Codex app-server did not exit after forced shutdown'));
        }, 1_000);
      }, 500);
    };
    const timeoutTimer = setTimeout(() => {
      stopChild(new Error(`Codex skills/list timed out after ${timeoutLabel}`));
    }, timeoutMs);

    child.stdin.on('error', () => {});
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== 25) continue;
        if (message.error) {
          stopChild(new Error(`Codex skills/list returned an error: ${JSON.stringify(message.error)}`));
          return;
        }
        answer = message.result?.data?.flatMap((row) => row.skills || []) || [];
        child.stdin.end();
        shutdownTimer = setTimeout(() => stopChild(), 1_000);
      }
    });
    child.on('error', (error) => finish(new Error(`Codex skills/list could not run: ${error.message}`)));
    child.on('exit', (code) => {
      if (stopError) finish(stopError);
      else if (answer) finish();
      else finish(new Error(stderr.trim() || `Codex app-server exited without skills/list (status ${String(code)})`));
    });
    const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
    send({ method: 'initialize', id: 0, params: { clientInfo: { name: 'flowcrew_installer', title: 'FlowCrew Installer', version: '1' } } });
    send({ method: 'initialized', params: {} });
    send({ method: 'skills/list', id: 25, params: { cwds: [cwd], forceReload: true } });
  });

  const expected = [
    ['ship', resolve(shipPath)],
    ['fc-status', resolve(statusPath)],
  ];
  for (const [name, path] of expected) {
    const found = listed.some((entry) => (
      entry.name === name
      && typeof entry.path === 'string'
      && resolve(entry.path) === path
      && entry.enabled !== false
    ));
    if (!found) throw new Error(`Codex did not enumerate ${name} at ${path}`);
  }
  process.stdout.write('  Codex skills/list enumerated ship and fc-status.\n');
} catch (error) {
  const detail = error instanceof Error ? error.message : 'unknown verification error';
  process.stderr.write(`Codex verification failed: ${detail}\n`);
  process.exitCode = 1;
}
NODE
}

CLAUDE_BIN=''
CODEX_BIN=''
if $INSTALL_CLAUDE; then
  if CLAUDE_BIN="$(command -v claude 2>/dev/null)"; then
    :
  else
    CLAUDE_BIN=''
    printf '%s\n' '↷ Claude Code CLI not found; skipped. Install: npm i -g @anthropic-ai/claude-code'
  fi
fi
if $INSTALL_CODEX; then
  if CODEX_BIN="$(command -v codex 2>/dev/null)"; then
    :
  else
    CODEX_BIN=''
    printf '%s\n' '↷ Codex CLI not found; skipped. Install: npm i -g @openai/codex'
  fi
fi

INSTALLED_CLAUDE=false
INSTALLED_CODEX=false

if [ -n "$CLAUDE_BIN" ]; then
  if $GLOBAL; then
    CLAUDE_TARGET="$HOME/.claude/commands"
  else
    CLAUDE_TARGET=".claude/commands"
  fi
  copy_and_verify "$SCRIPT_DIR/ship.md" "$CLAUDE_TARGET/ship.md"
  copy_and_verify "$SCRIPT_DIR/fc-status.md" "$CLAUDE_TARGET/fc-status.md"
  printf '✓ Claude Code skills installed and byte-verified at %s/\n' "$CLAUDE_TARGET"
  printf '%s\n' '  /ship       — hand off a plan to FlowCrew'
  printf '%s\n' '  /fc-status  — check run progress'
  INSTALLED_CLAUDE=true
fi

if [ -n "$CODEX_BIN" ]; then
  if $GLOBAL; then
    CODEX_TARGET="$HOME/.agents/skills"
  else
    CODEX_TARGET=".agents/skills"
  fi
  CODEX_SHIP="$CODEX_TARGET/ship/SKILL.md"
  CODEX_STATUS="$CODEX_TARGET/fc-status/SKILL.md"
  copy_and_verify "$SCRIPT_DIR/ship.md" "$CODEX_SHIP"
  copy_and_verify "$SCRIPT_DIR/fc-status.md" "$CODEX_STATUS"
  if ! verify_codex_enumeration "$CODEX_BIN" "$CODEX_SHIP" "$CODEX_STATUS"; then
    printf '%s\n' 'Codex skill verification failed; installation was not reported as successful.' >&2
    exit 1
  fi
  printf '✓ Codex skills installed and enumerated at %s/\n' "$CODEX_TARGET"
  printf '%s\n' '  $ship       — hand off a plan to FlowCrew (or choose ship from /skills)'
  printf '%s\n' '  $fc-status  — check run progress (or choose fc-status from /skills)'
  INSTALLED_CODEX=true
fi

printf '\n'
if $INSTALLED_CLAUDE && $INSTALLED_CODEX; then
  printf '%s\n' 'Done. In Claude Code use /ship; in Codex use $ship or choose ship from /skills.'
elif $INSTALLED_CLAUDE; then
  printf '%s\n' 'Done. In Claude Code use /ship.'
elif $INSTALLED_CODEX; then
  printf '%s\n' 'Done. In Codex use $ship or choose ship from /skills.'
else
  printf '%s\n' 'Done. No skills were installed because no requested agent CLI was found.'
fi
