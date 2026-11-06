#!/usr/bin/env bash
# Mirror the shared agent skills (.agents/skills, the source of truth) into
# .claude/skills so Claude Code picks them up. Run after editing any skill.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
rm -rf "$root/.claude/skills"
mkdir -p "$root/.claude"
cp -R "$root/.agents/skills" "$root/.claude/skills"
echo "Synced .agents/skills -> .claude/skills"
