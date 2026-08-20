# Programmatic Sidecar Observer SOP

## Purpose

Use a sidecar observer when the product appears to perform its operation correctly, but the user-visible failure occurs after data crosses into an OS service, GUI application, third-party process, browser extension, file watcher, or another black-box subsystem.

A sidecar observer is a small standalone program that reads the shared boundary without changing product code. Its job is to make **state transitions, semantic metadata, timing, and competing actors** observable. This is different from a shallow snapshot: a final value can look correct even when another process rewrote it, changed its type, or caused a downstream consumer to skip it.

## Entry Criteria

Use this SOP when at least one is true:

- Product logs end at a successful boundary call, but the downstream feature fails.
- Multiple processes can mutate the same shared state.
- The final payload is correct, but indexing, history, notification, rendering, or persistence differs.
- A working path and a failing path use apparently equivalent data.
- The failure may depend on metadata, ordering, debounce windows, ownership, or a later writer.
- Existing tools expose only a snapshot and not the transition sequence.

Prefer an existing debugger, trace facility, browser devtools, filesystem event monitor, or OS diagnostic command when it already exposes the required signal. Write a program only when the existing signal is incomplete or cannot be made machine-comparable.

Do not use this SOP as permission to monitor unrelated user activity. Obtain permission before observing production or sensitive boundaries.

## Exit Criteria

Do not declare the investigation complete until all of these are true:

- A repeatable trigger produces timestamped boundary evidence.
- Working and failing paths have been compared with equivalent benign inputs.
- The difference includes semantic state, not just an assumed actor.
- Independent evidence attributes the transition to a process or subsystem.
- A controlled one-variable A/B run confirms or falsifies that attribution.
- The original user-visible symptom is rechecked after the low-level state changes.
- Temporary observers are stopped, artifacts are removed, and external state is restored.

## SOP

### 1. Define the boundary contract

Write two statements before implementing an observer:

```text
User-visible red signal: <the exact behavior that fails>
Boundary transition that explains it: <the state sequence that must be observed>
```

Examples:

- “Paste works, but clipboard history has no entry” is not equivalent to “clipboard text was written.”
- “The API response is correct, but the page is wrong” is not equivalent to “the DOM stayed correct after extensions ran.”
- “The config file contains the new value” is not equivalent to “no watcher rewrote it 500 ms later.”

This prevents the observer from proving a nearby success while missing the user’s actual failure.

### 2. Choose the smallest observer

Use the least invasive option that exposes the contract:

1. Existing debugger or trace API.
2. Existing OS command with structured output.
3. Shell loop over a stable counter, event stream, or file metadata.
4. Small platform-native program using the real API.
5. Product instrumentation only if the boundary cannot be observed externally.

Prefer a platform-native program when language bindings preserve semantic types that shell tools flatten. For example, a paste command may show text but hide pasteboard types; a filesystem read may show contents but hide which process wrote them.

Keep the observer read-only. A probe that writes to the same boundary creates another actor and can invalidate attribution.

### 3. Specify the event schema before coding

Record enough information to compare transitions without dumping sensitive payloads:

```json
{
  "event": "boundary_change",
  "timestamp": "2026-08-20T08:44:55.846Z",
  "sequence": 2904,
  "observer": "macos-pasteboard",
  "frontmost_app": {
    "name": "Terminal",
    "bundle_id": "com.example.Terminal",
    "pid": 927
  },
  "semantic_types": ["public.utf8-plain-text"],
  "payload_bytes": 24,
  "payload_sha256": "..."
}
```

Use these field classes where available:

- **Timestamp:** ISO-8601 with enough precision to correlate independent logs.
- **Sequence/version:** change count, inode generation, event ID, revision, transaction ID, or monotonically increasing local sequence.
- **Actor context:** frontmost app, process ID, bundle/service name, parent process, connection, or request ID. Treat this as context, not proof of the writer.
- **Semantic metadata:** MIME/UTI types, flags, extended attributes, headers, source tags, permissions, ownership, status, or visibility markers.
- **Payload fingerprint:** byte count and cryptographic hash.
- **Optional benign prefix:** disabled by default; enable only for a unique non-sensitive test token.

A hash lets you detect “same payload, different semantics” without persisting user data.

### 4. Build a tight observation loop

The observer should:

- emit one structured event per detected state change;
- flush output immediately;
- expose start state and sequence number;
- accept a configurable polling interval when no event API exists;
- terminate cleanly on SIGINT/SIGTERM;
- avoid network access and boundary writes;
- produce output that a script can assert against.

Place throwaway source, binaries, PIDs, and logs under a temp directory unless the script is intentionally bundled as a reusable skill resource.

For a human-triggered GUI action:

1. Start the observer first.
2. Display one exact action and one unique token.
3. Let the user perform only that action.
4. Capture the observer and OS logs before asking for interpretation.
5. Repeat with the working path using an equivalent token.

Use `scripts/hitl-loop.template.sh` when the action cannot be automated.

### 5. Capture working and failing timelines

Use unique benign tokens and preserve all other variables:

```text
working token: DEBUG_WORKING_<nonce>
failing token: DEBUG_FAILING_<nonce>
```

Compare events as ordered timelines, not unordered records:

```text
T+0 ms    original writer changes state, hash=A, types=[text]
T+560 ms  second change, hash=A, types=[text, transient]
T+575 ms  downstream consumer reads or skips final state
```

Look for:

- the same hash appearing under a new sequence number;
- metadata changing while payload bytes remain identical;
- a second process reading immediately before a rewrite;
- a downstream consumer observing only the later state;
- rapid overwrite inside a polling/debounce interval;
- source, ownership, permission, or visibility markers changing;
- state returning to the old value after an apparently successful write.

### 6. Correlate independent evidence

Use at least two independent evidence sources before attributing causality:

- sidecar observer timeline;
- OS unified/system logs;
- process list and parent/child relationships;
- process open files or sockets;
- file/database/WAL modification timestamps;
- documented protocol behavior;
- executable strings that show capability;
- application-specific logs.

Executable strings and timestamp adjacency establish capability and correlation, not causality. A process reading state before a rewrite is a strong lead, but the controlled A/B run is what confirms ownership.

Align evidence by timestamp and sequence number. Avoid “log everything and grep”; each source should distinguish a ranked hypothesis.

### 7. Rank falsifiable hypotheses

Write 3–5 hypotheses in prediction form before disabling or changing anything:

```text
1. If process X performs the second rewrite, stopping X will remove the second sequence increment and metadata marker.
2. If the OS service adds the marker, stopping X will not change the timeline.
3. If the downstream consumer independently filters the product, it will still miss the entry when the marker is absent.
```

Show the ranking to the user. External applications may have intentional policies that the user recognizes immediately.

### 8. Isolate one actor with a controlled A/B run

Change one variable:

1. Save the current evidence and baseline state.
2. Ask permission before stopping, pausing, excluding, or reconfiguring an external application.
3. Prefer reversible controls: app exclusion rule, clean quit/relaunch, feature toggle, or short pause.
4. Repeat the same trigger with a new benign token.
5. Compare sequences, hashes, semantic metadata, downstream reads, and the original symptom.
6. Restore the actor or clearly tell the user what remains changed.

A green low-level timeline is necessary but not sufficient. Recheck the user-visible symptom because a second independent filter may still exist.

### 9. Assign fix ownership at the confirmed boundary

Fix the component that violates the confirmed contract:

- If product output is wrong before the boundary, fix the product.
- If a later third-party writer intentionally marks or replaces state, prefer that application’s exclusion/configuration or report the issue there.
- If the downstream consumer mishandles valid state, fix or report the consumer.
- Do not add delayed rewrites or races in product code merely to “win” against another process.

When no product-code seam owns the bug, document that a product regression test would be false confidence. Preserve the sidecar repro as operational evidence instead.

### 10. Clean up and record the finding

Before finishing:

- stop observer and log-stream processes;
- remove temporary source, binaries, PID files, and logs;
- restore or relaunch external applications;
- verify no product repository files were accidentally changed;
- record the confirmed timeline and causal A/B result;
- state which hypothesis won and why competing hypotheses lost.

## Worked Example: Same Payload, Different Semantics

A terminal multiplexer copied selected text successfully. Direct paste and a command-line paste read both returned the expected text, but a clipboard-history application had no entry.

A platform-native observer revealed two transitions:

```text
change 2904: hash=A, types=[plain-text]
change 2905: hash=A, types=[plain-text, transient]
```

OS logs showed a selection helper reading the general pasteboard between those transitions. The helper executable contained support for the transient pasteboard type, establishing capability. When the helper was quit with user consent and the same mouse-selection trigger was repeated:

```text
change 2908: hash=B, types=[plain-text]
```

There was no second rewrite, the history application read the plain-text item, and its persistence file changed. This confirmed that the helper’s restore operation added semantic metadata that instructed clipboard managers not to retain the item.

The correct fix boundary was the helper’s application-exclusion/configuration policy—not a delayed rewrite in the multiplexer.
