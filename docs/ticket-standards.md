# Ticket standards

Nimbus issues should describe the actual work, not repeat a fixed template body. Every ticket uses the following sections, but their length and detail should match the scope.

## Title

Use a short action-oriented title followed by a Fibonacci estimate: `(1)`, `(2)`, `(3)`, `(5)`, or `(8)`.

- **1 point:** a narrow correction with little uncertainty, such as changing one workflow step.
- **2 points:** a small behavior or configuration change contained in one area.
- **3 points:** a bounded feature with implementation and focused tests.
- **5 points:** a multi-component feature, integration, or operational workflow.
- **8 points:** cross-cutting architecture with significant integration and failure-mode work.

Estimate complexity, uncertainty, risk, and affected components. Do not select points to make a group of tickets look uniform.

## Description

Explain the specific problem, the intended outcome, and any context needed to understand the boundary. State dependencies or overlap with other issues. A closed ticket should link verifiable evidence such as its commit, pull request, tests, workflow, or current implementation.

Do not claim unverified test results, performance, production traffic, cloud resources, or completed functionality.

## Acceptance Criteria

Write unique, observable outcomes for that ticket. Criteria should describe what must be true, not prescribe unrelated implementation details.

Use only as many criteria as the work needs. A one-point correction may need two or three; a cross-cutting eight-point change may require eight or more. Varying counts are expected. Include tests when behavior can regress, security controls when the feature crosses a trust boundary, and failure handling when it changes a distributed path.

## Docs

Name the exact user, architecture, operational, or design documentation that changes. If the work has no documentation impact, write `No documentation change required` and briefly explain why.

## State and evidence

- Preserve the issue state when rewriting historical tickets.
- Keep unfinished work in open tickets and completed work in closed tickets.
- Link dependencies with `blocked by` or `depends on` language where execution order matters.
- Cross-reference overlapping tickets instead of presenting duplicate work as independent delivery.
- Use repository evidence; never rewrite history to make a ticket appear complete.

## Final review

Before saving an issue, reread it on GitHub and confirm the title estimate fits the work, every required section exists, the criteria are specific and proportional, links resolve, state is correct, and no boilerplate was copied from an unrelated ticket.
