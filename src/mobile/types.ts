export interface LocalFiles {
  /** Enumerate the vault; reject links where the host API exposes them.
   * The host confines logical paths. This port does not promise an OS sandbox.
   */
  list(): Promise<{ path: string; kind: 'file' | 'symlink' | 'directory' }[]>;
  /** Return null only for a missing file; validate parent paths and host file types. */
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  /** Create a directory idempotently; reject file/link ancestors or destinations. */
  mkdir(path: string): Promise<void>;
}

export interface RequestOptions {
  url: string;
  method: 'GET' | 'POST' | 'PATCH';
  headers: Record<string, string>;
  body?: string;
}
/** Transport must reject redirects; it must never forward Authorization to another origin. */
export type RequestPort = (options: RequestOptions) => Promise<{
  status: number; headers?: Record<string, string>; json: unknown;
}>;

export interface MobileChange {
  path: string; status: 'add' | 'modify' | 'delete'; digest: string; allowed: boolean; reason: string;
}
export interface MobileReview { id: string; head: string; changes: MobileChange[] }
export interface PullChange {
  path: string;
  kind: 'remote' | 'local' | 'conflict' | 'same';
  deleted: boolean;
}
export interface ExcludedRemoteFile { path: string; reason: string }
export interface PullPlan {
  id: string; head: string; initial: boolean; changes: PullChange[]; deletions: string[];
  /** Missing safe directories to create; existing local directories are never deleted. */
  directories: string[];
  summary: { remoteFiles: number; managedFiles: number; remoteDirectories: number; excluded: ExcludedRemoteFile[] };
}
export interface ApplyPullResult { preserved: string[] }
export type Resolution = 'local' | 'remote' | 'both';
export interface Confirmation { deletions: string[]; bulkDelete: boolean }
export interface ApplyEntry { path: string; before: string | null; after: string | null }
export interface BaselineFile { sha: string; size: number }
export interface PendingUpload { commit: string; parent: string; files: Record<string, BaselineFile | null> }
export interface MobileState {
  version: 1;
  repository: string;
  branch: string;
  head: string;
  /** Git blob identity and size only. Whole-vault bodies are never persisted. */
  baseline: Record<string, BaselineFile>;
  draft?: { review: MobileReview; files: Record<string, string | null> };
  pending?: PendingUpload;
  journal?: {
    head: string; baseline: Record<string, BaselineFile>; entries: ApplyEntry[];
    /** All safe remote directories to ensure at apply and recovery, not only the preview delta. */
    directories?: string[];
    /** Full remote namespace, including excluded files, for recovery collision checks. */
    inventory?: { files: string[]; directories: string[] };
  };
}
export interface StateStore {
  load(): Promise<MobileState | null>;
  /** Recoverable replacement (for example verified checksummed rotating slots).
   * Resolve only after read-back verification; load must recover the latest valid slot.
   */
  save(state: MobileState): Promise<void>;
}
