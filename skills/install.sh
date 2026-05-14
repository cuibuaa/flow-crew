#!/bin/bash
# Install FlowCrew skills for Claude Code and/or Codex
# Usage: ./install.sh [--claude] [--codex] [--global|--project]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_CLAUDE=false
INSTALL_CODEX=false
GLOBAL=true

for arg in "$@"; do
  case "$arg" in
    --claude) INSTALL_CLAUDE=true ;;
    --codex)  INSTALL_CODEX=true ;;
    --global) GLOBAL=true ;;
    --project) GLOBAL=false ;;
    --help|-h)
      echo "Usage: ./install.sh [--claude] [--codex] [--global|--project]"
      echo ""
      echo "  --claude   Install /ship and /fc-status for Claude Code"
      echo "  --codex    Install /ship and /fc-status for Codex"
      echo "  --global   Install to user-level config (~/.claude/commands/ or ~/.codex/commands/)"
      echo "  --project  Install to project-level config (.claude/commands/ or .codex/commands/)"
      echo ""
      echo "Default: installs both to user-level config."
      exit 0
      ;;
  esac
done

# Default: install both
if ! $INSTALL_CLAUDE && ! $INSTALL_CODEX; then
  INSTALL_CLAUDE=true
  INSTALL_CODEX=true
fi

if $INSTALL_CLAUDE; then
  if $GLOBAL; then
    TARGET="$HOME/.claude/commands"
  else
    TARGET=".claude/commands"
  fi
  mkdir -p "$TARGET"
  cp "$SCRIPT_DIR/ship.md" "$TARGET/ship.md"
  cp "$SCRIPT_DIR/fc-status.md" "$TARGET/fc-status.md"
  echo "✓ Claude Code skills installed to $TARGET/"
  echo "  /ship       — hand off plan to FlowCrew"
  echo "  /fc-status  — check run progress"
fi

if $INSTALL_CODEX; then
  if $GLOBAL; then
    TARGET="$HOME/.codex/commands"
  else
    TARGET=".codex/commands"
  fi
  mkdir -p "$TARGET"
  cp "$SCRIPT_DIR/ship.md" "$TARGET/ship.md"
  cp "$SCRIPT_DIR/fc-status.md" "$TARGET/fc-status.md"
  echo "✓ Codex skills installed to $TARGET/"
  echo "  /ship       — hand off plan to FlowCrew"
  echo "  /fc-status  — check run progress"
fi

echo ""
echo "Done! Type /ship in your agent to hand off tasks to FlowCrew."
