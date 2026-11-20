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
inputs:
- id: input-01
  path: /workspace/reference/frozen
  kind: directory
  frozen: true
- id: input-02
  path: /workspace/reference/frozen/check.py
  kind: file
  frozen: true
  sha256: bed78f058295787654cb6f6c35dd9fb793ec23cd291b67bc0030933dcaf08afb
- id: input-03
  path: /workspace/reference/frozen/worker.py
  kind: file
  frozen: true
  sha256: e94287f0e5702ecc715bd1f9d5a9000cb3a4cf1ae0fa372cd3787cb41bd53022
- id: input-04
  path: /workspace/reference/frozen/generator.py
  kind: file
  frozen: true
  sha256: 7e27cd5b3a6b45f3355b5680570ae5d44db62e04f1214d28b1d17858d5c5f321
- id: input-05
  path: /workspace/reference/frozen/base/module.py
  kind: file
  frozen: true
  sha256: 2850ec017d000afec702aa92b4b87cac748a2de3c95995d62a7427a0df207198
- id: input-06
  path: lib/__init__.py
  kind: file
  frozen: true
  sha256: f4a0e397707231f1587825c2fd3e23a257a87dc83c5cca74348fc992dae8a019
- id: input-07
  path: lib/client.py
  kind: file
  frozen: true
  sha256: aa2572e8c3a902c2024c275c5af05f864c0cb0aad7c85588f3dbd1f13dfbcc64
- id: input-08
  path: lib/tokens.py
  kind: file
  frozen: true
  sha256: 192ead6fcba676743aefc2feb7bfc98c19fdbaa12394321ebf1e5b23049cba0b
- id: input-09
  path: lib/schema.py
  kind: file
  frozen: true
  sha256: 237662a4a448dba6ca713d7578d1171415ea0c558d7dd8abf6dc098c8534ad61
- id: input-10
  path: /workspace/resources/vocab.json
  kind: file
  frozen: true
  sha256: 6ca5b460e7022c4c2c1252880fbc5040895dfd55c46e617d3f905624c229eddd
- id: input-11
  path: /workspace/resources/config.json
  kind: file
  frozen: true
  sha256: 1d8547af345f933dd9bb909e2015867c1f55f0b2b0a9e191c1d3a8d63606bad2
- id: input-12
  path: /workspace/runtime/library/codec.py
  kind: file
  frozen: true
  sha256: 7a37c9938d98befff71ba857a5e6236090a7854ebb7d4105c784816436c549a9
- id: input-13
  path: fixtures/input-13.dat
  kind: file
  frozen: true
- id: input-14
  path: fixtures/input-14.dat
  kind: file
  frozen: true
- id: input-15
  path: fixtures/input-15.dat
  kind: file
  frozen: true
- id: input-16
  path: fixtures/input-16.dat
  kind: file
  frozen: true
- id: input-17
  path: fixtures/input-17.dat
  kind: file
  frozen: true
- id: input-18
  path: fixtures/input-18.dat
  kind: file
  frozen: true
- id: input-19
  path: fixtures/input-19.dat
  kind: file
  frozen: true
- id: input-20
  path: fixtures/input-20.dat
  kind: file
  frozen: true
- id: input-21
  path: fixtures/input-21.dat
  kind: file
  frozen: true
- id: input-22
  path: fixtures/input-22.dat
  kind: file
  frozen: true
- id: input-23
  path: fixtures/input-23.dat
  kind: file
  frozen: true
outputs:
- path: lib/implementation.py
  kind: file
  existing: update
- path: tests
  kind: directory
  existing: update
- path: artifacts/checks
  kind: directory
  existing: create
commands:
- id: command-01
  argv:
  - /workspace/runtime/bin/python
  - -B
  - -m
  - pytest
  - -q
  - -p
  - no:cacheprovider
  - tests
  env:
    PATH: /workspace/runtime/bin:/usr/local/bin:/usr/bin:/bin
    HOME: /workspace/operator
    LANG: C.UTF-8
  inputs: []
  required: true
  durationMs: 60000
- id: command-02
  argv:
  - /workspace/runtime/bin/python
  - -B
  - /workspace/reference/frozen/check.py
  - --mode
  - final
  - --candidate
  - .
  - --out
  - artifacts/checks/result.json
  env:
    PATH: /workspace/runtime/bin:/usr/local/bin:/usr/bin:/bin
    HOME: /workspace/operator
    LANG: C.UTF-8
  inputs:
  - input-01
  - input-02
  - input-03
  - input-04
  - input-05
  - input-06
  - input-07
  - input-08
  - input-09
  - input-10
  - input-11
  - input-12
  required: true
  durationMs: 61000
results:
- id: label-01
  text: Synthetic result category 1.
- id: label-02
  text: Synthetic result category 2.
- id: label-03
  text: Synthetic result category 3.
- id: label-04
  text: Synthetic result category 4.
- id: label-05
  text: Synthetic result category 5.
- id: label-06
  text: Synthetic result category 6.
allowBlocked: false
---
# sample-a

This synthetic package assembles colored blocks. Command vectors and paths are inert parser data.
No command in this declaration is executed by the fixture tests.
