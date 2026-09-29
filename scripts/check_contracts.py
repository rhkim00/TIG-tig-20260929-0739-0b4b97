#!/usr/bin/env python3
"""Validate reviewable state-contract structure, not the deployed state machine."""
import json
from pathlib import Path


def main():
    root = Path(__file__).resolve().parents[1]
    contract = json.loads((root / "docs/contracts/task_states.json").read_text())
    states = set(contract["states"])
    terminal = set(contract["terminal"])
    pairs = set()
    reachable = {contract["initial"]}
    for edge in contract["transitions"]:
        assert edge["source"] in states and edge["target"] in states
        assert edge["source"] not in terminal, "A settled task must not reopen"
        key = (edge["source"], edge["event"])
        assert key not in pairs, "Ambiguous state/event"
        pairs.add(key)
        assert edge["guards"], "Explicit guard required"
        if edge["target"] == "PAID":
            assert edge["source"] == "AWAITING_REVIEW" and edge["settlement"] == "payout"
        elif edge["target"] == "REFUNDED":
            assert edge["settlement"] == "refund"
        else:
            assert edge["settlement"] == "none", "Nonterminal movement not allowed here"
        if edge["event"] in {"start", "submit", "resume"}:
            assert "current_claim_generation" in edge["guards"], "Stale worker must be fenced"
    while True:
        expanded = reachable | {e["target"] for e in contract["transitions"] if e["source"] in reachable}
        if expanded == reachable:
            break
        reachable = expanded
    assert reachable == states, "Unreachable state in contract"
    can_finish = set(terminal)
    while True:
        expanded = can_finish | {e["source"] for e in contract["transitions"] if e["target"] in can_finish}
        if expanded == can_finish:
            break
        can_finish = expanded
    assert can_finish == states, "State without any settlement path"
    print(f"State contract checks passed: {len(states)} states, {len(pairs)} transitions; static check only; runtime/DB guards are covered separately by application tests.")


if __name__ == "__main__":
    main()
