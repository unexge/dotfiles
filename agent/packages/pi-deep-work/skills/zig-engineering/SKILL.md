---
name: zig-engineering
description: Design, implement, review, and verify Zig changes with allocator ownership, explicit cleanup, error-union handling, comptime correctness, C boundary safety, formatting, and build tests. Use for build.zig and .zig changes.
license: MIT
---

# Zig engineering

- Read `build.zig`, target options, and repository scripts before choosing commands.
- Make allocator ownership and cleanup responsibility explicit.
- Pair each allocation or acquired resource with the correct `defer` or `errdefer` path.
- Review error unions and optionals without forced unwraps that erase valid failure states.
- Check comptime/runtime boundaries and generic constraints.
- Audit pointer lifetime, alignment, sentinel, integer cast, and C ABI assumptions.
- Verify relevant target and optimization modes when behavior can differ.
- Prefer repository-defined checks, with `zig fmt --check` and `zig build test` as fallbacks.
