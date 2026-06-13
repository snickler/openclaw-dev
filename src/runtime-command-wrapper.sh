#!/bin/sh
set -eu

cmd="$(basename "$0")"

say() {
  printf '%s\n' "$@" >&2
}

case "$cmd" in
  task|runSubagent)
    say "[hosted-openclaw] '$cmd' is a GitHub Copilot / VS Code orchestration primitive, not a shell command in hosted OpenClaw."
    say "[hosted-openclaw] Hosted equivalent: use 'agent_to_agent' for specialist delegation, or 'sessions_spawn' + 'subagents' + 'sessions_yield' for background work when those tools are exposed."
    say "[hosted-openclaw] If native coordination tools are unavailable, tell the operator which specialist to open in the Agents view instead of pretending the spawn happened."
    exit 64
    ;;
  read_agent)
    say "[hosted-openclaw] 'read_agent' is a Copilot CLI polling primitive and is not available here."
    say "[hosted-openclaw] Hosted equivalent: use 'sessions_history', 'sessions_list', or 'subagents' for an existing specialist/background session, or ask the operator to switch to that specialist."
    exit 64
    ;;
  ask_user)
    say "[hosted-openclaw] 'ask_user' is not available as a shell command in hosted OpenClaw."
    say "[hosted-openclaw] Ask the operator directly in the current chat."
    exit 64
    ;;
  squad|squad_decide|squad_state_read|squad_state_write|squad_state_append|squad_state_delete|squad_state_list|squad_state_health)
    say "[hosted-openclaw] '$cmd' depends on the Squad CLI or runtime state bridge, which is not mounted in this hosted OpenClaw deployment."
    say "[hosted-openclaw] The projected Squad contract is read-only here. Use the projected files and OpenClaw session tools, and be explicit when durable Squad state is unavailable."
    exit 78
    ;;
  code|codium)
    say "[hosted-openclaw] VS Code is not installed in this hosted runtime."
    say "[hosted-openclaw] Use OpenClaw's file/process tools instead."
    exit 64
    ;;
  copilot|github-copilot)
    say "[hosted-openclaw] GitHub Copilot CLI is not installed in this hosted runtime."
    say "[hosted-openclaw] Use GitHub MCP tools when they are already exposed, otherwise use gh for GitHub operations and OpenClaw-native coordination tools for hosted multi-agent work."
    exit 64
    ;;
  *)
    say "[hosted-openclaw] Unsupported hosted wrapper invocation: $cmd"
    exit 64
    ;;
esac
