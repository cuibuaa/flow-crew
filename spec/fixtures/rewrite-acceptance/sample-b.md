---
criteria:
- id: criterion-01
  text: 'Synthetic obligation 1: retain attributable evidence for the declared artifact.'
- id: criterion-02
  text: 'Synthetic obligation 2: retain attributable evidence for the declared artifact.'
- id: criterion-03
  text: 'Synthetic obligation 3: retain attributable evidence for the declared artifact.'
- id: criterion-04
  text: 'Synthetic obligation 4: retain attributable evidence for the declared artifact.'
- id: criterion-05
  text: 'Synthetic obligation 5: retain attributable evidence for the declared artifact.'
- id: criterion-06
  text: 'Synthetic obligation 6: retain attributable evidence for the declared artifact.'
- id: criterion-07
  text: 'Synthetic obligation 7: retain attributable evidence for the declared artifact.'
- id: criterion-08
  text: 'Synthetic obligation 8: retain attributable evidence for the declared artifact.'
- id: criterion-09
  text: 'Synthetic obligation 9: retain attributable evidence for the declared artifact.'
- id: criterion-10
  text: 'Synthetic obligation 10: retain attributable evidence for the declared artifact.'
- id: criterion-11
  text: 'Synthetic obligation 11: retain attributable evidence for the declared artifact.'
- id: criterion-12
  text: 'Synthetic obligation 12: retain attributable evidence for the declared artifact.'
- id: criterion-13
  text: 'Synthetic obligation 13: retain attributable evidence for the declared artifact.'
- id: criterion-14
  text: 'Synthetic obligation 14: retain attributable evidence for the declared artifact.'
- id: criterion-15
  text: 'Synthetic obligation 15: retain attributable evidence for the declared artifact.'
inputs:
- id: input-01
  path: docs/specification.md
  kind: file
  frozen: true
- id: input-02
  path: docs/readiness.md
  kind: file
  frozen: true
- id: input-03
  path: docs/evaluation.md
  kind: file
  frozen: true
- id: input-04
  path: /workspace/reference
  kind: directory
  frozen: true
- id: input-05
  path: /workspace/reference/setup.json
  kind: file
  frozen: true
- id: input-06
  path: /workspace/reference/probe-a.json
  kind: file
  frozen: true
- id: input-07
  path: /workspace/reference/probe-b.json
  kind: file
  frozen: true
- id: input-08
  path: /workspace/reference/probe-c.json
  kind: file
  frozen: true
- id: input-09
  path: /workspace/reference/second-tree
  kind: directory
  frozen: true
outputs:
- path: lib
  kind: directory
  existing: replace
- path: worker
  kind: directory
  existing: replace
- path: tests
  kind: directory
  existing: replace
- path: checks
  kind: directory
  existing: create
- path: docs/results
  kind: directory
  existing: create
- path: docs/report.md
  kind: file
  existing: create
- path: manifest.json
  kind: file
  existing: update
- path: manifest-lock.json
  kind: file
  existing: update
- path: compiler.json
  kind: file
  existing: update
- path: builder.mjs
  kind: file
  existing: create
- path: README.md
  kind: file
  existing: update
- path: GUIDE.md
  kind: file
  existing: update
- path: .ignore
  kind: file
  existing: update
- path: /workspace/external-results
  kind: directory
  existing: create
commands:
- id: command-01
  argv:
  - npm
  - ci
  env:
    PATH: /workspace/node/bin:/workspace/accelerator/bin:/workspace/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/platform/System32:/workspace/platform/System32/WindowsPowerShell/v1.0
    HOME: /workspace/operator
    LANG: C.UTF-8
    XDG_RUNTIME_DIR: /workspace/session
    DBUS_SESSION_BUS_ADDRESS: unix:path=/workspace/session/bus
    XDG_CACHE_HOME: /workspace/cache/xdg
    npm_config_cache: /workspace/cache/npm
    TMPDIR: /workspace/cache/tmp
    DATA_HOME: /workspace/cache/data
    DATA_OFFLINE: '1'
    APP_REFERENCE: /workspace/reference
    APP_RESOURCES: /workspace/resources
    APP_CACHE: /workspace/cache
    LD_LIBRARY_PATH: /workspace/accelerator/lib64
  inputs: []
  required: true
  durationMs: 60000
- id: command-02
  argv:
  - npm
  - run
  - task-02
  env:
    PATH: /workspace/node/bin:/workspace/accelerator/bin:/workspace/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/platform/System32:/workspace/platform/System32/WindowsPowerShell/v1.0
    HOME: /workspace/operator
    LANG: C.UTF-8
    XDG_RUNTIME_DIR: /workspace/session
    DBUS_SESSION_BUS_ADDRESS: unix:path=/workspace/session/bus
    XDG_CACHE_HOME: /workspace/cache/xdg
    npm_config_cache: /workspace/cache/npm
    TMPDIR: /workspace/cache/tmp
    DATA_HOME: /workspace/cache/data
    DATA_OFFLINE: '1'
    APP_REFERENCE: /workspace/reference
    APP_RESOURCES: /workspace/resources
    APP_CACHE: /workspace/cache
    LD_LIBRARY_PATH: /workspace/accelerator/lib64
  inputs: []
  required: true
  durationMs: 61000
- id: command-03
  argv:
  - npm
  - run
  - task-03
  env:
    PATH: /workspace/node/bin:/workspace/accelerator/bin:/workspace/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/platform/System32:/workspace/platform/System32/WindowsPowerShell/v1.0
    HOME: /workspace/operator
    LANG: C.UTF-8
    XDG_RUNTIME_DIR: /workspace/session
    DBUS_SESSION_BUS_ADDRESS: unix:path=/workspace/session/bus
    XDG_CACHE_HOME: /workspace/cache/xdg
    npm_config_cache: /workspace/cache/npm
    TMPDIR: /workspace/cache/tmp
    DATA_HOME: /workspace/cache/data
    DATA_OFFLINE: '1'
    APP_REFERENCE: /workspace/reference
    APP_RESOURCES: /workspace/resources
    APP_CACHE: /workspace/cache
    LD_LIBRARY_PATH: /workspace/accelerator/lib64
  inputs: []
  required: true
  durationMs: 62000
- id: command-04
  argv:
  - npm
  - test
  env:
    PATH: /workspace/node/bin:/workspace/accelerator/bin:/workspace/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/platform/System32:/workspace/platform/System32/WindowsPowerShell/v1.0
    HOME: /workspace/operator
    LANG: C.UTF-8
    XDG_RUNTIME_DIR: /workspace/session
    DBUS_SESSION_BUS_ADDRESS: unix:path=/workspace/session/bus
    XDG_CACHE_HOME: /workspace/cache/xdg
    npm_config_cache: /workspace/cache/npm
    TMPDIR: /workspace/cache/tmp
    DATA_HOME: /workspace/cache/data
    DATA_OFFLINE: '1'
    APP_REFERENCE: /workspace/reference
    APP_RESOURCES: /workspace/resources
    APP_CACHE: /workspace/cache
    LD_LIBRARY_PATH: /workspace/accelerator/lib64
  inputs: []
  required: true
  durationMs: 63000
- id: command-05
  argv:
  - /workspace/cache/venvs/first/bin/python
  - -m
  - pytest
  - -q
  - worker/tests
  env:
    PATH: /workspace/node/bin:/workspace/accelerator/bin:/workspace/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/platform/System32:/workspace/platform/System32/WindowsPowerShell/v1.0
    HOME: /workspace/operator
    LANG: C.UTF-8
    XDG_RUNTIME_DIR: /workspace/session
    DBUS_SESSION_BUS_ADDRESS: unix:path=/workspace/session/bus
    XDG_CACHE_HOME: /workspace/cache/xdg
    npm_config_cache: /workspace/cache/npm
    TMPDIR: /workspace/cache/tmp
    DATA_HOME: /workspace/cache/data
    DATA_OFFLINE: '1'
    APP_REFERENCE: /workspace/reference
    APP_RESOURCES: /workspace/resources
    APP_CACHE: /workspace/cache
    LD_LIBRARY_PATH: /workspace/accelerator/lib64
  inputs: []
  required: true
  durationMs: 64000
- id: command-06
  argv:
  - /workspace/cache/venvs/second/bin/python
  - -m
  - pytest
  - -q
  - worker/tests
  env:
    PATH: /workspace/node/bin:/workspace/accelerator/bin:/workspace/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/platform/System32:/workspace/platform/System32/WindowsPowerShell/v1.0
    HOME: /workspace/operator
    LANG: C.UTF-8
    XDG_RUNTIME_DIR: /workspace/session
    DBUS_SESSION_BUS_ADDRESS: unix:path=/workspace/session/bus
    XDG_CACHE_HOME: /workspace/cache/xdg
    npm_config_cache: /workspace/cache/npm
    TMPDIR: /workspace/cache/tmp
    DATA_HOME: /workspace/cache/data
    DATA_OFFLINE: '1'
    APP_REFERENCE: /workspace/reference
    APP_RESOURCES: /workspace/resources
    APP_CACHE: /workspace/cache
    LD_LIBRARY_PATH: /workspace/accelerator/lib64
  inputs: []
  required: true
  durationMs: 65000
- id: command-07
  argv:
  - npm
  - run
  - task-07
  env:
    PATH: /workspace/node/bin:/workspace/accelerator/bin:/workspace/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/platform/System32:/workspace/platform/System32/WindowsPowerShell/v1.0
    HOME: /workspace/operator
    LANG: C.UTF-8
    XDG_RUNTIME_DIR: /workspace/session
    DBUS_SESSION_BUS_ADDRESS: unix:path=/workspace/session/bus
    XDG_CACHE_HOME: /workspace/cache/xdg
    npm_config_cache: /workspace/cache/npm
    TMPDIR: /workspace/cache/tmp
    DATA_HOME: /workspace/cache/data
    DATA_OFFLINE: '1'
    APP_REFERENCE: /workspace/reference
    APP_RESOURCES: /workspace/resources
    APP_CACHE: /workspace/cache
    LD_LIBRARY_PATH: /workspace/accelerator/lib64
  inputs:
  - input-04
  required: true
  durationMs: 66000
- id: command-08
  argv:
  - npm
  - run
  - task-08
  - --
  - --from
  - /workspace/reference/dataset
  env:
    PATH: /workspace/node/bin:/workspace/accelerator/bin:/workspace/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/platform/System32:/workspace/platform/System32/WindowsPowerShell/v1.0
    HOME: /workspace/operator
    LANG: C.UTF-8
    XDG_RUNTIME_DIR: /workspace/session
    DBUS_SESSION_BUS_ADDRESS: unix:path=/workspace/session/bus
    XDG_CACHE_HOME: /workspace/cache/xdg
    npm_config_cache: /workspace/cache/npm
    TMPDIR: /workspace/cache/tmp
    DATA_HOME: /workspace/cache/data
    DATA_OFFLINE: '1'
    APP_REFERENCE: /workspace/reference
    APP_RESOURCES: /workspace/resources
    APP_CACHE: /workspace/cache
    LD_LIBRARY_PATH: /workspace/accelerator/lib64
  inputs:
  - input-04
  required: true
  durationMs: 67000
- id: command-09
  argv:
  - npm
  - run
  - task-09
  env:
    PATH: /workspace/node/bin:/workspace/accelerator/bin:/workspace/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/platform/System32:/workspace/platform/System32/WindowsPowerShell/v1.0
    HOME: /workspace/operator
    LANG: C.UTF-8
    XDG_RUNTIME_DIR: /workspace/session
    DBUS_SESSION_BUS_ADDRESS: unix:path=/workspace/session/bus
    XDG_CACHE_HOME: /workspace/cache/xdg
    npm_config_cache: /workspace/cache/npm
    TMPDIR: /workspace/cache/tmp
    DATA_HOME: /workspace/cache/data
    DATA_OFFLINE: '1'
    APP_REFERENCE: /workspace/reference
    APP_RESOURCES: /workspace/resources
    APP_CACHE: /workspace/cache
    LD_LIBRARY_PATH: /workspace/accelerator/lib64
  inputs: []
  required: true
  durationMs: 68000
- id: command-10
  argv:
  - npm
  - run
  - task-10
  env:
    PATH: /workspace/node/bin:/workspace/accelerator/bin:/workspace/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/platform/System32:/workspace/platform/System32/WindowsPowerShell/v1.0
    HOME: /workspace/operator
    LANG: C.UTF-8
    XDG_RUNTIME_DIR: /workspace/session
    DBUS_SESSION_BUS_ADDRESS: unix:path=/workspace/session/bus
    XDG_CACHE_HOME: /workspace/cache/xdg
    npm_config_cache: /workspace/cache/npm
    TMPDIR: /workspace/cache/tmp
    DATA_HOME: /workspace/cache/data
    DATA_OFFLINE: '1'
    APP_REFERENCE: /workspace/reference
    APP_RESOURCES: /workspace/resources
    APP_CACHE: /workspace/cache
    LD_LIBRARY_PATH: /workspace/accelerator/lib64
  inputs:
  - input-04
  required: true
  durationMs: 69000
- id: command-11
  argv:
  - npm
  - run
  - task-11
  env:
    PATH: /workspace/node/bin:/workspace/accelerator/bin:/workspace/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/platform/System32:/workspace/platform/System32/WindowsPowerShell/v1.0
    HOME: /workspace/operator
    LANG: C.UTF-8
    XDG_RUNTIME_DIR: /workspace/session
    DBUS_SESSION_BUS_ADDRESS: unix:path=/workspace/session/bus
    XDG_CACHE_HOME: /workspace/cache/xdg
    npm_config_cache: /workspace/cache/npm
    TMPDIR: /workspace/cache/tmp
    DATA_HOME: /workspace/cache/data
    DATA_OFFLINE: '1'
    APP_REFERENCE: /workspace/reference
    APP_RESOURCES: /workspace/resources
    APP_CACHE: /workspace/cache
    LD_LIBRARY_PATH: /workspace/accelerator/lib64
  inputs:
  - input-04
  required: true
  durationMs: 70000
- id: command-12
  argv:
  - npm
  - run
  - task-12
  env:
    PATH: /workspace/node/bin:/workspace/accelerator/bin:/workspace/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/platform/System32:/workspace/platform/System32/WindowsPowerShell/v1.0
    HOME: /workspace/operator
    LANG: C.UTF-8
    XDG_RUNTIME_DIR: /workspace/session
    DBUS_SESSION_BUS_ADDRESS: unix:path=/workspace/session/bus
    XDG_CACHE_HOME: /workspace/cache/xdg
    npm_config_cache: /workspace/cache/npm
    TMPDIR: /workspace/cache/tmp
    DATA_HOME: /workspace/cache/data
    DATA_OFFLINE: '1'
    APP_REFERENCE: /workspace/reference
    APP_RESOURCES: /workspace/resources
    APP_CACHE: /workspace/cache
    LD_LIBRARY_PATH: /workspace/accelerator/lib64
  inputs: []
  required: true
  durationMs: 71000
- id: command-13
  argv:
  - npm
  - run
  - task-13
  env:
    PATH: /workspace/node/bin:/workspace/accelerator/bin:/workspace/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/platform/System32:/workspace/platform/System32/WindowsPowerShell/v1.0
    HOME: /workspace/operator
    LANG: C.UTF-8
    XDG_RUNTIME_DIR: /workspace/session
    DBUS_SESSION_BUS_ADDRESS: unix:path=/workspace/session/bus
    XDG_CACHE_HOME: /workspace/cache/xdg
    npm_config_cache: /workspace/cache/npm
    TMPDIR: /workspace/cache/tmp
    DATA_HOME: /workspace/cache/data
    DATA_OFFLINE: '1'
    APP_REFERENCE: /workspace/reference
    APP_RESOURCES: /workspace/resources
    APP_CACHE: /workspace/cache
    LD_LIBRARY_PATH: /workspace/accelerator/lib64
  inputs:
  - input-04
  required: true
  durationMs: 72000
- id: command-14
  argv:
  - npm
  - run
  - task-14
  - --
  - --replay
  - /workspace/reference/records
  env:
    PATH: /workspace/node/bin:/workspace/accelerator/bin:/workspace/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/platform/System32:/workspace/platform/System32/WindowsPowerShell/v1.0
    HOME: /workspace/operator
    LANG: C.UTF-8
    XDG_RUNTIME_DIR: /workspace/session
    DBUS_SESSION_BUS_ADDRESS: unix:path=/workspace/session/bus
    XDG_CACHE_HOME: /workspace/cache/xdg
    npm_config_cache: /workspace/cache/npm
    TMPDIR: /workspace/cache/tmp
    DATA_HOME: /workspace/cache/data
    DATA_OFFLINE: '1'
    APP_REFERENCE: /workspace/reference
    APP_RESOURCES: /workspace/resources
    APP_CACHE: /workspace/cache
    LD_LIBRARY_PATH: /workspace/accelerator/lib64
  inputs:
  - input-04
  required: true
  durationMs: 73000
- id: command-15
  argv:
  - npm
  - run
  - task-15
  - --
  - --window
  - 02:00-06:00
  - --tz
  - Etc/UTC
  env:
    PATH: /workspace/node/bin:/workspace/accelerator/bin:/workspace/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/platform/System32:/workspace/platform/System32/WindowsPowerShell/v1.0
    HOME: /workspace/operator
    LANG: C.UTF-8
    XDG_RUNTIME_DIR: /workspace/session
    DBUS_SESSION_BUS_ADDRESS: unix:path=/workspace/session/bus
    XDG_CACHE_HOME: /workspace/cache/xdg
    npm_config_cache: /workspace/cache/npm
    TMPDIR: /workspace/cache/tmp
    DATA_HOME: /workspace/cache/data
    DATA_OFFLINE: '1'
    APP_REFERENCE: /workspace/reference
    APP_RESOURCES: /workspace/resources
    APP_CACHE: /workspace/cache
    LD_LIBRARY_PATH: /workspace/accelerator/lib64
  inputs:
  - input-04
  required: false
  durationMs: 74000
- id: command-16
  argv:
  - npm
  - run
  - task-16
  env:
    PATH: /workspace/node/bin:/workspace/accelerator/bin:/workspace/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/platform/System32:/workspace/platform/System32/WindowsPowerShell/v1.0
    HOME: /workspace/operator
    LANG: C.UTF-8
    XDG_RUNTIME_DIR: /workspace/session
    DBUS_SESSION_BUS_ADDRESS: unix:path=/workspace/session/bus
    XDG_CACHE_HOME: /workspace/cache/xdg
    npm_config_cache: /workspace/cache/npm
    TMPDIR: /workspace/cache/tmp
    DATA_HOME: /workspace/cache/data
    DATA_OFFLINE: '1'
    APP_REFERENCE: /workspace/reference
    APP_RESOURCES: /workspace/resources
    APP_CACHE: /workspace/cache
    LD_LIBRARY_PATH: /workspace/accelerator/lib64
  inputs:
  - input-04
  required: true
  durationMs: 75000
- id: command-17
  argv:
  - npm
  - run
  - task-17
  - --
  - --records
  - /workspace/reference/records
  env:
    PATH: /workspace/node/bin:/workspace/accelerator/bin:/workspace/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/platform/System32:/workspace/platform/System32/WindowsPowerShell/v1.0
    HOME: /workspace/operator
    LANG: C.UTF-8
    XDG_RUNTIME_DIR: /workspace/session
    DBUS_SESSION_BUS_ADDRESS: unix:path=/workspace/session/bus
    XDG_CACHE_HOME: /workspace/cache/xdg
    npm_config_cache: /workspace/cache/npm
    TMPDIR: /workspace/cache/tmp
    DATA_HOME: /workspace/cache/data
    DATA_OFFLINE: '1'
    APP_REFERENCE: /workspace/reference
    APP_RESOURCES: /workspace/resources
    APP_CACHE: /workspace/cache
    LD_LIBRARY_PATH: /workspace/accelerator/lib64
  inputs:
  - input-04
  required: true
  durationMs: 76000
- id: command-18
  argv:
  - npm
  - run
  - task-18
  env:
    PATH: /workspace/node/bin:/workspace/accelerator/bin:/workspace/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/platform/System32:/workspace/platform/System32/WindowsPowerShell/v1.0
    HOME: /workspace/operator
    LANG: C.UTF-8
    XDG_RUNTIME_DIR: /workspace/session
    DBUS_SESSION_BUS_ADDRESS: unix:path=/workspace/session/bus
    XDG_CACHE_HOME: /workspace/cache/xdg
    npm_config_cache: /workspace/cache/npm
    TMPDIR: /workspace/cache/tmp
    DATA_HOME: /workspace/cache/data
    DATA_OFFLINE: '1'
    APP_REFERENCE: /workspace/reference
    APP_RESOURCES: /workspace/resources
    APP_CACHE: /workspace/cache
    LD_LIBRARY_PATH: /workspace/accelerator/lib64
  inputs:
  - input-04
  required: true
  durationMs: 77000
- id: command-19
  argv:
  - python3
  - /workspace/reference/tools/check_data.py
  env:
    PATH: /workspace/node/bin:/workspace/accelerator/bin:/workspace/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/platform/System32:/workspace/platform/System32/WindowsPowerShell/v1.0
    HOME: /workspace/operator
    LANG: C.UTF-8
    XDG_RUNTIME_DIR: /workspace/session
    DBUS_SESSION_BUS_ADDRESS: unix:path=/workspace/session/bus
    XDG_CACHE_HOME: /workspace/cache/xdg
    npm_config_cache: /workspace/cache/npm
    TMPDIR: /workspace/cache/tmp
    DATA_HOME: /workspace/cache/data
    DATA_OFFLINE: '1'
    APP_REFERENCE: /workspace/reference
    APP_RESOURCES: /workspace/resources
    APP_CACHE: /workspace/cache
    LD_LIBRARY_PATH: /workspace/accelerator/lib64
  inputs:
  - input-04
  required: true
  durationMs: 78000
- id: command-20
  argv:
  - sha256sum
  - --quiet
  - -c
  - /workspace/reference/tools/checksums.txt
  env:
    PATH: /workspace/node/bin:/workspace/accelerator/bin:/workspace/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/platform/System32:/workspace/platform/System32/WindowsPowerShell/v1.0
    HOME: /workspace/operator
    LANG: C.UTF-8
    XDG_RUNTIME_DIR: /workspace/session
    DBUS_SESSION_BUS_ADDRESS: unix:path=/workspace/session/bus
    XDG_CACHE_HOME: /workspace/cache/xdg
    npm_config_cache: /workspace/cache/npm
    TMPDIR: /workspace/cache/tmp
    DATA_HOME: /workspace/cache/data
    DATA_OFFLINE: '1'
    APP_REFERENCE: /workspace/reference
    APP_RESOURCES: /workspace/resources
    APP_CACHE: /workspace/cache
    LD_LIBRARY_PATH: /workspace/accelerator/lib64
  inputs:
  - input-04
  required: true
  durationMs: 79000
- id: command-21
  argv:
  - python3
  - /workspace/reference/tools/check_layout.py
  env:
    PATH: /workspace/node/bin:/workspace/accelerator/bin:/workspace/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/platform/System32:/workspace/platform/System32/WindowsPowerShell/v1.0
    HOME: /workspace/operator
    LANG: C.UTF-8
    XDG_RUNTIME_DIR: /workspace/session
    DBUS_SESSION_BUS_ADDRESS: unix:path=/workspace/session/bus
    XDG_CACHE_HOME: /workspace/cache/xdg
    npm_config_cache: /workspace/cache/npm
    TMPDIR: /workspace/cache/tmp
    DATA_HOME: /workspace/cache/data
    DATA_OFFLINE: '1'
    APP_REFERENCE: /workspace/reference
    APP_RESOURCES: /workspace/resources
    APP_CACHE: /workspace/cache
    LD_LIBRARY_PATH: /workspace/accelerator/lib64
  inputs:
  - input-04
  required: true
  durationMs: 80000
- id: command-22
  argv:
  - /workspace/platform/System32/inspector.exe
  - --query-record=index,id,title,active,bytes
  - --format=csv,noheader
  env:
    PATH: /workspace/node/bin:/workspace/accelerator/bin:/workspace/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/platform/System32:/workspace/platform/System32/WindowsPowerShell/v1.0
    HOME: /workspace/operator
    LANG: C.UTF-8
    XDG_RUNTIME_DIR: /workspace/session
    DBUS_SESSION_BUS_ADDRESS: unix:path=/workspace/session/bus
    XDG_CACHE_HOME: /workspace/cache/xdg
    npm_config_cache: /workspace/cache/npm
    TMPDIR: /workspace/cache/tmp
    DATA_HOME: /workspace/cache/data
    DATA_OFFLINE: '1'
    APP_REFERENCE: /workspace/reference
    APP_RESOURCES: /workspace/resources
    APP_CACHE: /workspace/cache
    LD_LIBRARY_PATH: /workspace/accelerator/lib64
  inputs: []
  required: false
  durationMs: 81000
- id: command-23
  argv:
  - systemctl
  - --user
  - is-active
  - demo.service
  env:
    PATH: /workspace/node/bin:/workspace/accelerator/bin:/workspace/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/platform/System32:/workspace/platform/System32/WindowsPowerShell/v1.0
    HOME: /workspace/operator
    LANG: C.UTF-8
    XDG_RUNTIME_DIR: /workspace/session
    DBUS_SESSION_BUS_ADDRESS: unix:path=/workspace/session/bus
    XDG_CACHE_HOME: /workspace/cache/xdg
    npm_config_cache: /workspace/cache/npm
    TMPDIR: /workspace/cache/tmp
    DATA_HOME: /workspace/cache/data
    DATA_OFFLINE: '1'
    APP_REFERENCE: /workspace/reference
    APP_RESOURCES: /workspace/resources
    APP_CACHE: /workspace/cache
    LD_LIBRARY_PATH: /workspace/accelerator/lib64
  inputs: []
  required: true
  durationMs: 82000
results: []
allowBlocked: true
---
# sample-b

This synthetic package assembles colored blocks. Command vectors and paths are inert parser data.
No command in this declaration is executed by the fixture tests.
