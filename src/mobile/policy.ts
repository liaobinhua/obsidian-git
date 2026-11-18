export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_OPERATION_BYTES = 50 * 1024 * 1024;
const extensions = new Set(['md', 'txt', 'csv', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp']);
const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/;

export function validPath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && !/[\\:\x00-\x1f\x7f]/.test(path)
    && new TextDecoder().decode(new TextEncoder().encode(path)) === path
    && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
}
export function allowedPath(path: string): boolean {
  const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase();
  return validPath(path) && path.split('/').every(part => !part.startsWith('.')
    && !['config', 'configs', 'keys', 'ssh'].includes(part.toLowerCase())
    && !/(?:^|[-_.])(?:secrets?|credentials?|tokens?|passwords?|private[-_]?keys?)(?:[-_.]|$)/i.test(part))
    && extension !== undefined && extensions.has(extension);
}
export function checkPaths(paths: string[], directories: string[] = []): void {
  if (new Set(paths).size !== paths.length || new Set(directories).size !== directories.length) throw new Error('文件路径存在重复冲突（collision）。');
  const seen = new Map<string, string>();
  const files = new Set(paths.map(path => path.normalize('NFC').toLowerCase()));
  for (const { path, directory } of [...paths.map(path => ({ path, directory: false })), ...directories.map(path => ({ path, directory: true }))]) {
    if (!validPath(path)) throw new Error('文件路径不安全。');
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      const folded = prefix.normalize('NFC').toLowerCase();
      if (seen.has(folded) && seen.get(folded) !== prefix || (i < parts.length || directory) && files.has(folded)) {
        throw new Error('文件路径存在大小写、Unicode 或目录冲突（collision）。');
      }
      seen.set(folded, prefix);
    }
  }
}
export function checkSecret(text: string): void {
  if (secret.test(text)) throw new Error('内容包含疑似令牌或私钥（secret），请移除后重新检查。');
}
export function checkBytes(bytes: Uint8Array): void {
  if (bytes.length > MAX_FILE_BYTES) throw new Error('单个文件不能超过 20 MiB。');
  checkSecret(new TextDecoder().decode(bytes));
}
export function budget(size: number): void {
  if (size > MAX_OPERATION_BYTES) throw new Error('操作及其备份超过 50 MiB，请分批处理。');
}
export function toBase64(bytes: Uint8Array): string {
  let value = '';
  for (let start = 0; start < bytes.length; start += 16384) value += String.fromCharCode(...bytes.subarray(start, start + 16384));
  return btoa(value);
}
export function fromBase64(value: string): Uint8Array {
  const compact = value.replace(/[\r\n\t ]/g, '');
  if (compact.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || compact.length % 4 !== 0) throw new Error('文件编码响应无效。');
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  let last = 0;
  // A repeated-group regex exhausts V8's stack on valid multi-MiB blobs.
  // Scan each character once and verify the unused bits of the final sextet.
  for (let i = 0; i < compact.length - padding; i++) {
    const code = compact.charCodeAt(i);
    last = code >= 65 && code <= 90 ? code - 65 : code >= 97 && code <= 122 ? code - 71
      : code >= 48 && code <= 57 ? code + 4 : code === 43 ? 62 : code === 47 ? 63 : -1;
    if (last < 0) throw new Error('文件编码响应无效。');
  }
  if (padding === 2 && (last & 15) !== 0 || padding === 1 && (last & 3) !== 0) throw new Error('文件编码响应无效。');
  const decoded = atob(compact);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  checkBytes(bytes);
  return bytes;
}
export async function blobSha(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const input = new Uint8Array(header.length + bytes.length);
  input.set(header); input.set(bytes, header.length);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', input)), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function validSha(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value); }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('GitHub 响应格式无效。');
  return value as Record<string, unknown>;
}
export function sha(value: unknown): string {
  if (!validSha(value)) throw new Error('GitHub 响应中的 SHA 无效。');
  return value;
}
export function binding(repository: string, branch: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository) || repository.endsWith('.git')) throw new Error('仓库格式须为 owner/repository。');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(branch) || branch.includes('..') || branch.endsWith('.') || branch.endsWith('.lock') || branch.split('/').some(part => !part || part.startsWith('.'))) throw new Error('分支名称无效。');
}
