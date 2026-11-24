#!/bin/sh
# Frozen evaluator. Run from the project directory: sh evaluate.sh
# Measures the cost of two sets of kept items (baseline.txt = the starting set,
# candidate.txt = the proposal) against the price list in items.txt, where each
# line is "<item> <cost> <required|optional>". A candidate is valid only when it
# keeps every required item and names no unknown item.
# Exit 0: the candidate is valid and both costs were measured.
# Exit 1: the candidate is invalid. Exit 2: an input file cannot be read.
# Uses only shell built-ins, so it runs in seconds with no PATH, network or model.

for file in items.txt baseline.txt candidate.txt; do
  [ -r "$file" ] || { echo "error: cannot read $file" >&2; exit 2; }
done

measure() { # $1 = file of kept items; sets cost, valid
  kept=" "
  while read -r name; do [ -n "$name" ] && kept="$kept$name "; done < "$1"
  cost=0; valid=true; known=" "
  while read -r name price need; do
    [ -n "$name" ] || continue
    known="$known$name "
    case "$kept" in
      *" $name "*) cost=$((cost + price)) ;;
      *) [ "$need" = required ] && valid=false ;;
    esac
  done < items.txt
  for name in $kept; do
    case "$known" in *" $name "*) ;; *) valid=false ;; esac
  done
}

measure baseline.txt; baseline_cost=$cost; baseline_valid=$valid
measure candidate.txt; candidate_cost=$cost; candidate_valid=$valid
improved=false
[ "$candidate_valid" = true ] && [ "$candidate_cost" -lt "$baseline_cost" ] && improved=true
echo "baseline_cost=$baseline_cost"
echo "baseline_valid=$baseline_valid"
echo "candidate_cost=$candidate_cost"
echo "candidate_valid=$candidate_valid"
echo "improved=$improved"
[ "$candidate_valid" = true ] || exit 1
