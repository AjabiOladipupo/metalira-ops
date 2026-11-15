---
description: Check whether the current phase's "done when" is met
argument-hint: <phase number>
---

Check phase $ARGUMENTS against docs/BUILD_PLAN.md and its phase file.

For each slice and the phase's "done when" line, report: met / not met / needs a manual check, with the evidence (test name, file, or the steps I should take on the preview). Run the full test suite, then the money-reviewer and security-reviewer subagents over everything merged in this phase. End with a short list of what is left before the next phase can start. Do not change any code.
