#!/bin/sh
set -eu
cd "$(nice -n 19 dirname "$0")/.."

# Preserve caller ownership and affinity; no login account or ambient state.
passwd_file=$(nice -n 19 mktemp /tmp/flowcrew-passwd.XXXXXX)
trap 'nice -n 19 rm -f "$passwd_file"' EXIT
nice -n 19 chmod 644 "$passwd_file"
cpuset=$(nice -n 19 awk '/^Cpus_allowed_list:/ { print $2 }' /proc/self/status)
nice -n 19 test -n "$cpuset"
nice -n 19 docker run --rm \
  --cpuset-cpus "$cpuset" \
  --user "$(nice -n 19 id -u):$(nice -n 19 id -g)" \
  --network none \
  --tmpfs /tmp/flowcrew-home:rw,nosuid,nodev \
  --env HOME=/tmp/flowcrew-home \
  --env PATH=/usr/local/bin:/usr/bin:/bin \
  --workdir /workspace \
  --mount "type=bind,source=$PWD,target=/workspace" \
  --mount "type=bind,source=$passwd_file,target=/etc/passwd,readonly" \
  node:22.22.2-bookworm \
  nice -n 19 sh -ceu '
    nice -n 19 test ! -e "$HOME/.fc"
    ! command -v codex
    ! command -v claude
    nice -n 19 node -e '\''const assert = require("node:assert/strict");
      const os = require("node:os");
      assert.throws(() => os.userInfo(), { code: "ERR_SYSTEM_ERROR" });
      assert.equal(os.homedir(), process.env.HOME);'\''
    nice -n 19 npm run test:portable
  '
