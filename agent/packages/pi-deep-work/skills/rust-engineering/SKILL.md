---
name: rust-engineering
description: Design, implement, review, and verify Rust changes with explicit ownership, sound error boundaries, safe concurrency, targeted Cargo gates, and repository conventions. Use for Cargo workspaces and .rs changes.
license: MIT
---

# Rust engineering

- Read the Cargo workspace and affected package boundaries before editing.
- Model ownership and state transitions so illegal states cannot be constructed.
- Import standard types instead of using qualified paths unless repository convention requires otherwise.
- Keep module-local items private or public according to repository conventions; do not invent intermediate visibility without need.
- Preserve error meaning. Add context at boundaries and avoid catch-all strings inside domain code.
- Audit `unsafe` preconditions, pinning, aliasing, layout, FFI, and drop order explicitly.
- For concurrent code, state the owner, cancellation path, wakeup rule, and Send/Sync assumptions.
- Check feature-gated and platform-gated code affected by the change.
- Prefer focused regression tests through public behavior. Avoid tests that only mirror implementation.
- Run repository-defined gates. Otherwise use Cargo format check, check, targeted tests, workspace tests, and Clippy as applicable.
