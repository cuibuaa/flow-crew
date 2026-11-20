import type { Brief } from '../../dist-rewrite/contract/brief.js';
import type { Plan } from '../../dist-rewrite/contract/plan.js';
// Public benchmark and synthetic declarations; no private run content belongs here.
// Gate stages carry no instruction, so the instruction a planner once wrote for a gate is not part of these shapes.
export const recordedShapes: readonly { source: string; brief: Brief; plan: Plan | null }[] = [
  {
    "source": "round1/item-3",
    "brief": {
      "criteria": [
        {
          "id": "requirement-1",
          "text": "`LRU.get(\"missing\", \"fallback\")` currently raises `KeyError` on an empty cache instead of returning `\"fallback\"`. Repair `get` for both `LRI` and `LRU`."
        },
        {
          "id": "requirement-2",
          "text": "For an absent key without an `on_miss` callback, `get` must return the supplied default (or `None` when omitted) without inserting the key; that lookup increments `miss_count` and `soft_miss_count` once each."
        },
        {
          "id": "requirement-3",
          "text": "For an existing key, `get` must return the stored value unchanged, including `None`, `False`, and zero, and increment `hit_count` once without incrementing either miss counter."
        },
        {
          "id": "requirement-4",
          "text": "A successful `LRU.get` must make that key most recently used, so the next insertion into a full cache evicts the other, least recently used key."
        },
        {
          "id": "requirement-5",
          "text": "A successful `LRI.get` must leave insertion order unchanged, so the next insertion into a full cache evicts the earliest inserted key even if it was just read."
        },
        {
          "id": "requirement-6",
          "text": "When `on_miss` is configured, `get` must call it with the missing key, return and cache its result (including a false value), increment `miss_count` once without incrementing `soft_miss_count`, and serve later reads as cache hits without calling the callback again."
        },
        {
          "id": "requirement-7",
          "text": "Run the visible reproduction and checks with `python3 -m unittest discover -s tests -p 'test_*.py' -v`."
        }
      ],
      "inputs": [
        {
          "id": "input-1",
          "path": ".github",
          "kind": "directory",
          "frozen": false
        },
        {
          "id": "input-2",
          "path": ".gitignore",
          "kind": "file",
          "frozen": false
        },
        {
          "id": "input-3",
          "path": ".readthedocs.yaml",
          "kind": "file",
          "frozen": false
        },
        {
          "id": "input-4",
          "path": "CHANGELOG.md",
          "kind": "file",
          "frozen": false
        },
        {
          "id": "input-5",
          "path": "LICENSE",
          "kind": "file",
          "frozen": false
        },
        {
          "id": "input-6",
          "path": "MANIFEST.in",
          "kind": "file",
          "frozen": false
        },
        {
          "id": "input-7",
          "path": "README.md",
          "kind": "file",
          "frozen": false
        },
        {
          "id": "input-8",
          "path": "TODO.rst",
          "kind": "file",
          "frozen": false
        },
        {
          "id": "input-9",
          "path": "boltons",
          "kind": "directory",
          "frozen": false
        },
        {
          "id": "input-10",
          "path": "docs",
          "kind": "directory",
          "frozen": false
        },
        {
          "id": "input-11",
          "path": "misc",
          "kind": "directory",
          "frozen": false
        },
        {
          "id": "input-12",
          "path": "pytest.ini",
          "kind": "file",
          "frozen": false
        },
        {
          "id": "input-13",
          "path": "requirements-test.txt",
          "kind": "file",
          "frozen": false
        },
        {
          "id": "input-14",
          "path": "setup.cfg",
          "kind": "file",
          "frozen": false
        },
        {
          "id": "input-15",
          "path": "setup.py",
          "kind": "file",
          "frozen": false
        },
        {
          "id": "input-16",
          "path": "tests",
          "kind": "directory",
          "frozen": false
        },
        {
          "id": "input-17",
          "path": "tox.ini",
          "kind": "file",
          "frozen": false
        }
      ],
      "outputs": [
        {
          "path": "boltons",
          "kind": "directory",
          "existing": "update"
        }
      ],
      "commands": [
        {
          "id": "test",
          "argv": [
            "python3",
            "-m",
            "unittest",
            "discover",
            "-s",
            "tests",
            "-p",
            "test_*.py",
            "-v"
          ],
          "env": {},
          "inputs": [
            "input-1",
            "input-2",
            "input-3",
            "input-4",
            "input-5",
            "input-6",
            "input-7",
            "input-8",
            "input-9",
            "input-10",
            "input-11",
            "input-12",
            "input-13",
            "input-14",
            "input-15",
            "input-16",
            "input-17"
          ],
          "required": true
        }
      ],
      "results": [],
      "allowBlocked": false,
      "body": "Recorded declaration. Criteria are copied in full; explicit IDs use fixture declarations."
    },
    "plan": {
      "stages": [
        {
          "id": "repair_cache_get",
          "role": "coder",
          "purpose": "work",
          "after": [],
          "instruction": "Repair bounded-cache get defaults for LRI and LRU in boltons/cacheutils.py. The initial diff is empty and the evidence ledger has no validation facts. LRI.get currently returns self[key] directly; LRU inherits get and overrides __getitem__ to update recency. Use the current artifacts and any subsequent ledger facts, and make the smallest appropriate repair preserving existing lookup, callback, ordering, and counter semantics. For missing keys without on_miss, return the supplied default or None, leave membership unchanged, and increment miss_count and soft_miss_count exactly once each. Existing values, including None, False, and zero, must be returned unchanged with exactly one hit and no misses. LRU successful reads must refresh recency; LRI successful reads must leave insertion order unchanged. A successful on_miss callback must receive the missing key, have its result cached even if false, increment miss_count only once with no soft miss, and not run again for later hits. Reproduce the visible failure, then verify the repair with the required command python3 -m unittest discover -s tests -p 'test_*.py' -v. Also run meaningful targeted property checks for both classes covering explicit and omitted defaults, unchanged membership on misses, exact counter deltas, false stored and callback values, callback call arguments and reuse, and eviction after successful reads. Keep additional probe scripts and caches in private scratch, and preserve the visible tests without weakening coverage. Deliver changes under boltons only; explain any test changes if necessary rather than silently changing the acceptance checks. Record commands, exit codes, concise outputs, and relevant file:line references in your structured result. If this is a repair retry, address the gate's reproduced findings and rerun necessary verification on the repaired tree.",
          "skills": []
        },
        {
          "id": "review_cache_get",
          "role": "qa",
          "purpose": "gate",
          "after": [
            "repair_cache_get"
          ],
          "skills": [],
          "commands": [
            "test"
          ],
          "repair": {
            "stage": "fix_review_findings",
            "returnsTo": "review_cache_get"
          }
        },
        {
          "id": "fix_review_findings",
          "role": "coder",
          "purpose": "work",
          "after": [
            "repair_cache_get"
          ],
          "instruction": "Repair the independent QA gate's confirmed findings using the current diff and evidence ledger. Preserve all seven brief requirements and existing coverage. Run focused verification for the repair and the brief-required command python3 -m unittest discover -s tests -p 'test_*.py' -v. Keep probes and caches in private scratch and deliver product changes under boltons. Record commands, exit codes, concise excerpts, file:line references, and any unresolved findings in the structured result. The scheduler returns the repaired tree to the same independent gate; do not write verdict files or engine-owned records.",
          "skills": []
        }
      ]
    }
  },
  {
    "source": "synthetic/package-consolidation",
    "brief": {
      "criteria": [
        {
          "id": "requirement-1",
          "text": "Consolidate the synthetic block-processing package into one project while retaining its declared reference inputs."
        },
        {
          "id": "requirement-2",
          "text": "Preserve the reference implementation behavior except for the seven explicitly declared changes below."
        },
        {
          "id": "requirement-3",
          "text": "Delete unused modules and merge duplicated processing code without removing reachable behavior."
        },
        {
          "id": "requirement-4",
          "text": "Deliver an ordered operator migration and rollback procedure in the package report."
        },
        {
          "id": "requirement-5",
          "text": "Two batches created on the same day retain separate result files and diagnostic records."
        },
        {
          "id": "requirement-6",
          "text": "Recompute a block summary when its source bytes or declared processing policy changes; reuse unchanged summaries."
        },
        {
          "id": "requirement-7",
          "text": "Blocks with distinct declared identities remain distinct even when their labels and colors match."
        },
        {
          "id": "requirement-8",
          "text": "One reconciliation function updates only pending blocks; incomplete reference inventories leave them unchanged."
        },
        {
          "id": "requirement-9",
          "text": "An edit changes only its targeted block fields and reports a failed save to the caller."
        },
        {
          "id": "requirement-10",
          "text": "A missing explicitly configured reference store produces a startup error without creating replacement data."
        },
        {
          "id": "requirement-11",
          "text": "Every stored block state remains selectable and filterable, including unknown legacy states."
        },
        {
          "id": "requirement-12",
          "text": "Inventory every reachable and unused module from each synthetic package entrypoint and identify removals."
        },
        {
          "id": "requirement-13",
          "text": "Compare reference and final behavior on identical synthetic inputs with fixed clocks and offline dependency doubles."
        },
        {
          "id": "requirement-14",
          "text": "Document the final module responsibilities, merged implementations and retained restrictions with source references."
        },
        {
          "id": "requirement-15",
          "text": "Record direct build, test and lint exits after the final write, plus retained-module import and CLI checks."
        },
        {
          "id": "requirement-16",
          "text": "For each declared change, report its regression and preservation evidence; document migration verification and rollback."
        }
      ],
      "inputs": [
        {
          "id": "input-1",
          "path": "reference-inputs",
          "kind": "directory",
          "frozen": true
        },
        {
          "id": "input-2",
          "path": "requirements.txt",
          "kind": "file",
          "frozen": false
        }
      ],
      "outputs": [
        {
          "path": "docs/package-report.md",
          "kind": "file",
          "existing": "create"
        }
      ],
      "commands": [
        {
          "id": "build",
          "argv": [
            "make",
            "build"
          ],
          "env": {},
          "inputs": [
            "input-1",
            "input-2"
          ],
          "required": true
        },
        {
          "id": "test",
          "argv": [
            "python3",
            "-m",
            "pytest",
            "-q"
          ],
          "env": {},
          "inputs": [
            "input-1",
            "input-2"
          ],
          "required": true
        },
        {
          "id": "lint",
          "argv": [
            "make",
            "lint"
          ],
          "env": {},
          "inputs": [
            "input-1",
            "input-2"
          ],
          "required": true
        }
      ],
      "results": [],
      "allowBlocked": true,
      "body": "Synthetic block-processing package declaration. Bounds, identities and ordering are authored test data."
    },
    "plan": {
      "stages": [
        {
          "id": "author",
          "role": "coder",
          "purpose": "work",
          "after": [],
          "instruction": "Consolidate the synthetic block-processing package and deliver docs/package-report.md. Preserve the frozen reference-inputs directory. Implement every declared change and retain behavior outside those changes. Use offline synthetic input and dependency doubles for parity checks. Run the required build, test and lint commands and record their direct exits. Document module responsibilities, removed duplicates, regression evidence, migration verification and rollback. Report any unavailable evidence honestly through the structured result.",
          "skills": []
        },
        {
          "id": "review",
          "role": "qa",
          "purpose": "gate",
          "after": [
            "author"
          ],
          "skills": [],
          "commands": [
            "build",
            "test",
            "lint"
          ],
          "repair": {
            "stage": "repair_review",
            "returnsTo": "review"
          }
        },
        {
          "id": "repair_review",
          "role": "coder",
          "purpose": "work",
          "after": [
            "author"
          ],
          "instruction": "Repair the independent review findings in the synthetic package and docs/package-report.md. Preserve the frozen reference-inputs directory and all declared identities. Rerun the required build, test and lint commands after the final write, record direct exits, and update the report evidence. Return unresolved limitations honestly through the structured result.",
          "skills": []
        }
      ]
    }
  }
];
export const firstPlanRefusals: readonly { source: string; proposal: Plan }[] = [
  {
    "source": "round1/item-3",
    "proposal": {
      "stages": [
        {
          "id": "repair_cache_get",
          "role": "coder",
          "purpose": "work",
          "after": [],
          "instruction": "Repair bounded-cache get defaults for LRI and LRU in boltons/cacheutils.py. The initial diff is empty and the evidence ledger has no validation facts. LRI.get currently returns self[key] directly; LRU inherits get and overrides __getitem__ to update recency. Use the current artifacts and any subsequent ledger facts, and make the smallest appropriate repair preserving existing lookup, callback, ordering, and counter semantics. For missing keys without on_miss, return the supplied default or None, leave membership unchanged, and increment miss_count and soft_miss_count exactly once each. Existing values, including None, False, and zero, must be returned unchanged with exactly one hit and no misses. LRU successful reads must refresh recency; LRI successful reads must leave insertion order unchanged. A successful on_miss callback must receive the missing key, have its result cached even if false, increment miss_count only once with no soft miss, and not run again for later hits. Reproduce the visible failure, then verify the repair with the required command python3 -m unittest discover -s tests -p 'test_*.py' -v. Also run meaningful targeted property checks for both classes covering explicit and omitted defaults, unchanged membership on misses, exact counter deltas, false stored and callback values, callback call arguments and reuse, and eviction after successful reads. Keep additional probe scripts and caches in private scratch, and preserve the visible tests without weakening coverage. Deliver changes under boltons only; explain any test changes if necessary rather than silently changing the acceptance checks. Record commands, exit codes, concise outputs, and relevant file:line references in your structured result. If this is a repair retry, address the gate's reproduced findings and rerun necessary verification on the repaired tree.",
          "skills": []
        },
        {
          "id": "review_cache_get",
          "role": "qa",
          "purpose": "gate",
          "after": [
            "repair_cache_get"
          ],
          "skills": [],
          "commands": [
            "test"
          ],
          "repair": {
            "stage": "repair_cache_get",
            "returnsTo": "review_cache_get"
          }
        }
      ]
    }
  }
];
