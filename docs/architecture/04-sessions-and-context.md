# Persistent Sessions and Context Propagation

The extension supports two context mechanisms:

- `initialContext`, which controls how a newly-created child conversation starts.
- `session`, which creates or continues a deterministic named child Pi session.

## Initial context

`initialContext` accepts:

| Value | Behavior |
| --- | --- |
| `"empty"` | Start a fresh child conversation without parent history. This is the default. |
| `"parent"` | Seed a newly-created child conversation from the current parent session snapshot. |

For existing named sessions, `initialContext` is recorded as requested but ignored by Pi because the conversation already exists.

## Parent session snapshots

When a call needs parent context, `index.ts` serializes:

1. `ctx.sessionManager.getHeader()`
2. all entries from `ctx.sessionManager.getBranch()`

The snapshot is written as JSONL. `runner.ts` rewrites the session header cwd to the child effective cwd before passing it to the child process.

Child CLI behavior differs by session type:

- Ephemeral with parent context: `--session <snapshot-file>`
- New named session with parent context: `--fork <snapshot-file> --session-id <derived-id>`
- Empty ephemeral: `--no-session`

## Named session identity

When a call provides `session`, `index.ts` derives the Pi session ID from:

```text
pi-subagent/v1
parent session id
effective cwd
agent name
logical session handle
```

The SHA-256 digest is truncated and prefixed with `subagent.`.

This means:

- The same handle with the same parent session, cwd, and agent continues the same child session.
- The same handle with a different agent resolves to a different child session.
- The same handle with a different cwd resolves to a different child session.

## Parent requirements

Named sessions require a persisted parent Pi session. They are rejected when:

- the parent is running without a session file, or
- the parent is itself a temporary parent-seeded subagent session.

That guard prevents durable child sessions from being anchored to a transient parent identity.

## Session directory handling

If the parent uses a custom session directory, it is forwarded to child invocations. If the parent uses Pi's default session directory, the extension derives that path with [`session-paths.ts`](../../session-paths.ts) and creates it when needed for lock files.

## Locking

Named sessions are protected by [`session-lock.ts`](../../session-lock.ts):

- A lock is a directory named `<session-id>.lock`.
- The lock contains `owner.json` with token, pid, timestamps, session ID, agent, handle, and cwd.
- A heartbeat updates the owner timestamp every 30 seconds.
- Locks older than 2 minutes are reported as stale, but not removed automatically.
- Locks are released only if their token still matches.

The extension also keeps an in-memory active-session set to prevent duplicate use inside one extension process.

