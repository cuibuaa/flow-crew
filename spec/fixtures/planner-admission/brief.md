---
terminal_states:
  complete:
    paths: [results/report.md]
---
# Goal
Compare a faster data transformation with an existing reference and publish an honest measured result.
Create only these three project outputs: results/report.md, results/parity.json, results/benchmark.json.
Do not overwrite existing outputs. The project is initially empty. Use one mandatory independent review gate.
# What the report must show
1. Exact row parity between reference and candidate on identical inputs, including row and difference counts.
2. Reproduction of the reference aggregate to a tolerance of 1e-6 on the same input rows.
3. Reference and candidate wall times on 8192 rows with the same resources and recorded load; state the ratio.
4. Byte identical output across two candidate runs on identical inputs.
5. Checks after the last write, with each command's direct exit code and totals.
6. Reused machinery and bounded pieces not reused; if the speed ratio is below four, publish measured bounds.
