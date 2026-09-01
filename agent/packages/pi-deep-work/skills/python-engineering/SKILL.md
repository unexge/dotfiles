---
name: python-engineering
description: Design, implement, review, and verify Python changes using the repository environment, typed boundaries, scoped exceptions, resource cleanup, async correctness, pytest, Ruff, and configured type checks. Use for pyproject.toml and .py changes.
license: MIT
---

# Python engineering

- Preserve the repository's package manager, virtual environment, and lock file.
- Parse external data at typed boundaries and keep `Any` from spreading inward.
- Distinguish absent values from false or empty values.
- Catch only exceptions the current boundary can handle; preserve causes and useful context.
- Use context managers for files, locks, transactions, and temporary resources.
- Audit async cancellation, task ownership, blocking calls, and cleanup.
- Prefer tests through public behavior and real lightweight dependencies over internal mocks.
- Run configured pytest, Ruff, and type-check commands through the selected project runner.
