# p2w overnight build

Done means the universal debug APK installs, boots its own Node server and tools,
offers the five requested models and provider onboarding, and resumes the same
12-step codemode submission after process death with P1–P4 passing.

Work is bounded to the existing app plus one Android host, runtime bundler,
torture harness, emulator proof driver, and CI workflow. No remote environments,
new plugin framework, or real provider calls are in scope.

1. Read Principles and repository/spec/handoff documents. Capture baseline check.
2. Frame and design. Compare Android packaging candidates. Keep one storage owner.
3. Core. Pin Pi 1.3.0, install codemode, offer model policy, prove K1/K2/K3/K3b/K-pg
   with a reusable runner, including one real 10-second run. Check, test, commit, push.
4. Android. Package Node plus dependencies and app, foreground service and WebView,
   production assets, onboarding. Build universal debug APK. Inspect and scan it.
   Check, test, commit, push.
5. Emulator. Install and launch, exercise local tools and interrupted codemode at
   folded/unfolded sizes, capture screenshots/video and computed verdicts.
   Check, test, commit, push.
6. CI and draft PR. Add workflow, verify all required commands, publish one draft,
   inspect CI and repair. Never merge or mark ready.
7. Audit evidence and decisions with an independent reviewer, stop owned processes,
   report exact done-bar status and all remaining limitations.

For each unit: state the hypothesis, change the smallest necessary surface, run
the real feature, record VERIFIED / NOT VERIFIED / INCONCLUSIVE, and fix failures
before advancing. Evidence goes under /workspace/badlogic-torture/proof and local
.agent-artifacts. No credentials are read or bundled.

High rigor applies to execution and recovery: observe nested call 3 before killing,
verify actual log multiplicities, journal return value, conversation and submission
IDs, and automatic continuation without sending a second prompt. Android gets an
installed runtime proof, not only a successful Gradle invocation.
