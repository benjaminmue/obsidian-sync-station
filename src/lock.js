// One process-wide lock for operations that read or replace the whole vault.
// A tar snapshot taken while a restore is clearing the vault, or a restore
// running over a half-written snapshot, silently produces a broken result, so
// these operations refuse to overlap instead of queueing: the caller gets
// `busy` and can retry once the other one is done.

let holder = null;

// Name of the operation holding the lock, or null.
export function lockHolder() {
  return holder;
}

// Runs fn while holding the lock, or returns a `busy` result without running
// it when another operation holds the lock.
export async function withLock(name, fn) {
  if (holder) return { ok: false, error: "busy", busyWith: holder };
  holder = name;
  try {
    return await fn();
  } finally {
    holder = null;
  }
}

// Restoring into the live vault is the one operation sync must not run beside:
// ob would push the half-restored vault, deletions included, to the remote.
export const RESTORE_VAULT = "restore-vault";
