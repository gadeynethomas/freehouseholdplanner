// Removing a removed device's late changes from a document that already took them in (K8).
//
// A device that was offline during an unpairing can meet the removed device before it hears of the
// removal, and merge changes the household refuses. Once it hears of the removal, it rebuilds its
// document without those changes. Its own later edits depended on them in the change history, so
// they are replayed field by field on the clean document, under a new actor id.
import * as A from '@automerge/automerge';
import type { Household, HouseholdDoc } from './model.ts';

export interface PurgeResult {
  doc: Household;
  /** Changes by the removed device that were dropped. */
  dropped: number;
  /** Other changes that depended on them and were replayed. */
  replayed: number;
  /** Replayed fields whose parent no longer exists (e.g. a task only the removed device created). */
  skipped: number;
}

type Path = (string | number)[];
type Edit = { kind: 'set'; path: string[] } | { kind: 'delete'; path: string[] };

/** Returns null when nothing needs purging. */
export function purgeChanges(
  doc: Household,
  isRefused: (actor: string, seq: number) => boolean,
  actor: string,
): PurgeResult | null {
  const changes = A.getAllChanges(doc);
  const decoded = changes.map(A.decodeChange);
  const refused = new Set<string>();
  const dependent = new Set<string>();
  for (const change of inCausalOrder(decoded)) {
    if (isRefused(change.actor, change.seq)) refused.add(change.hash);
    else if (change.deps.some((dep) => refused.has(dep) || dependent.has(dep))) {
      dependent.add(change.hash);
    }
  }
  if (refused.size === 0) return null;

  const kept = changes.filter((_, index) => {
    const hash = decoded[index]?.hash ?? '';
    return !refused.has(hash) && !dependent.has(hash);
  });
  let clean = A.applyChanges(A.init<HouseholdDoc>({ actor }), kept)[0];
  let skipped = 0;
  for (const change of inCausalOrder(decoded)) {
    if (!dependent.has(change.hash)) continue;
    const after = A.view(doc, [change.hash]);
    const edits = editsOf(A.diff(doc, change.deps, [change.hash]));
    clean = A.change(clean, (draft) => {
      for (const edit of edits) if (!applyEdit(draft, after, edit)) skipped += 1;
    });
  }
  return { doc: clean, dropped: refused.size, replayed: dependent.size, skipped };
}

function inCausalOrder<T extends { hash: string; deps: string[] }>(changes: T[]): T[] {
  const byHash = new Map(changes.map((change) => [change.hash, change]));
  const ordered: T[] = [];
  const done = new Set<string>();
  const visit = (change: T): void => {
    if (done.has(change.hash)) return;
    done.add(change.hash);
    for (const dep of change.deps) {
      const parent = byHash.get(dep);
      if (parent !== undefined) visit(parent);
    }
    ordered.push(change);
  };
  for (const change of changes) visit(change);
  return ordered;
}

/** Turns Automerge patches into whole-field edits; edits inside a text become a set of that text. */
function editsOf(patches: A.Patch[]): Edit[] {
  const edits = new Map<string, Edit>();
  for (const patch of patches) {
    const path = patch.path as Path;
    const last = path.at(-1);
    const insideText = typeof last === 'number';
    const fieldPath = (insideText ? path.slice(0, -1) : path).map(String);
    const kind = patch.action === 'del' && !insideText ? 'delete' : 'set';
    const key = JSON.stringify(fieldPath);
    edits.delete(key);
    edits.set(key, { kind, path: fieldPath });
  }
  return [...edits.values()];
}

function applyEdit(draft: unknown, after: unknown, edit: Edit): boolean {
  const key = edit.path.at(-1);
  const parent = lookup(draft, edit.path.slice(0, -1));
  if (key === undefined || !isRecord(parent)) return false;
  if (edit.kind === 'delete') {
    Reflect.deleteProperty(parent, key);
    return true;
  }
  const value = lookup(after, edit.path);
  if (value === undefined) return false;
  parent[key] = JSON.parse(JSON.stringify(value)) as unknown;
  return true;
}

function lookup(root: unknown, path: string[]): unknown {
  let node = root;
  for (const key of path) {
    if (!isRecord(node)) return undefined;
    node = node[key];
  }
  return node;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
