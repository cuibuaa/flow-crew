#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

# Preserve caller ownership and CPU affinity. An empty passwd database makes
# the missing-login-account condition independent of the host's numeric uid.
passwd_file=$(mktemp /tmp/flowcrew-passwd.XXXXXX)
trap 'rm -f "$passwd_file"' EXIT
chmod 644 "$passwd_file"
cpuset=$(awk '/^Cpus_allowed_list:/ { print $2 }' /proc/self/status)
test -n "$cpuset"

docker run --rm \
  --cpuset-cpus "$cpuset" \
  --user "$(id -u):$(id -g)" \
  --network none \
  --tmpfs /tmp/flowcrew-home:rw,nosuid,nodev \
  --env HOME=/tmp/flowcrew-home \
  --env PATH=/usr/local/bin:/usr/bin:/bin \
  --workdir /workspace \
  --mount "type=bind,source=$PWD,target=/workspace" \
  --mount "type=bind,source=$passwd_file,target=/etc/passwd,readonly" \
  node:22-bookworm \
  sh -ceu '
    test ! -e "$HOME/.fc"
    ! command -v codex
    ! command -v claude
    node -e '\''const assert = require("node:assert/strict");
      const os = require("node:os");
      assert.throws(() => os.userInfo(), { code: "ERR_SYSTEM_ERROR" });
      assert.equal(os.homedir(), process.env.HOME);'\''
    node ./node_modules/vitest/vitest.mjs run \
      spec/spec-purity.test.ts \
      spec/test-isolation.test.ts \
      spec/rehearse-isolation.test.ts \
      spec/no-passwd-entry.test.ts
  '
