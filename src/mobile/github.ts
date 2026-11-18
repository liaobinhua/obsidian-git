import type { BaselineFile, RequestPort } from './types.ts';
import { allowedPath, binding, blobSha, budget, checkBytes, checkPaths, checkSecret, fromBase64, MAX_FILE_BYTES, object, sha, toBase64, validPath } from './policy.ts';

export interface RemoteTree {
  head: string; tree: string; files: Record<string, BaselineFile>;
  /** All remote leaf paths, including excluded files kept by base_tree uploads. */
  paths: string[];
}

export class GitHubError extends Error {
  readonly status: number;
  readonly remaining?: number;
  readonly reset?: number;
  constructor(status: number, headers: Record<string, string> = {}) {
    super(status === 401 ? 'GitHub 凭据无效，请检查 SecretStorage 中的令牌。'
      : status === 403 || status === 429 ? 'GitHub 拒绝访问或请求达到限额，请稍后重试。'
      : status === 409 || status === 422 ? '远端已变化或拒绝更新，请重新检查。'
      : status === 0 ? 'GitHub 网络请求失败；本地草稿已保留。' : `GitHub 操作失败（${status}），本地草稿已保留。`);
    this.status = status;
    const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    if (/^\d+$/.test(normalized['x-ratelimit-remaining'] ?? '')) this.remaining = Number(normalized['x-ratelimit-remaining']);
    if (/^\d+$/.test(normalized['x-ratelimit-reset'] ?? '')) this.reset = Number(normalized['x-ratelimit-reset']);
  }
}

export class GitHubClient {
  readonly repository: string;
  readonly branch: string;
  private readonly token: () => Promise<string>;
  private readonly request: RequestPort;
  constructor(options: { repository: string; branch?: string; token: () => Promise<string>; request: RequestPort }) {
    this.repository = options.repository; this.branch = options.branch ?? 'main';
    binding(this.repository, this.branch);
    this.token = options.token; this.request = options.request;
  }
  private async call(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<Record<string, unknown>> {
    let token;
    try { token = await this.token(); } catch { throw new GitHubError(401); }
    if (!token || /\s/.test(token)) throw new GitHubError(401);
    let response;
    try {
      response = await this.request({
        url: `https://api.github.com/repos/${this.repository}/git/${path}`, method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new GitHubError(0); }
    if (response.status !== (method === 'POST' ? 201 : 200)) throw new GitHubError(response.status, response.headers);
    return object(response.json);
  }
  async head(): Promise<string> {
    const result = await this.call('GET', `ref/heads/${this.branch.split('/').map(encodeURIComponent).join('/')}`);
    const ref = object(result.object);
    if (result.ref !== `refs/heads/${this.branch}` || ref.type !== 'commit') throw new Error('GitHub 分支响应无效。');
    return sha(ref.sha);
  }
  async snapshot(): Promise<RemoteTree> {
    const head = await this.head();
    const commit = await this.call('GET', `commits/${head}`);
    if (sha(commit.sha) !== head) throw new Error('GitHub 提交响应不匹配。');
    const tree = sha(object(commit.tree).sha);
    const result = await this.call('GET', `trees/${tree}?recursive=1`);
    if (result.truncated !== false) throw new Error('远端文件列表被截断，无法安全读取完整文库。');
    if (sha(result.sha) !== tree || !Array.isArray(result.tree) || result.tree.length > 100000) throw new Error('GitHub 文件树响应无效。');
    const files: Record<string, BaselineFile> = Object.create(null) as Record<string, BaselineFile>;
    const paths: string[] = [];
    for (const raw of result.tree) {
      const entry = object(raw);
      if (typeof entry.path !== 'string' || !validPath(entry.path)) throw new Error('远端文件路径无效。');
      if (entry.type === 'tree' && entry.mode === '040000') { sha(entry.sha); continue; }
      paths.push(entry.path);
      if (entry.type !== 'blob' || !['100644', '100755', '120000', '160000'].includes(String(entry.mode))) throw new Error('远端文件树包含不支持的节点。');
      sha(entry.sha);
      if (!allowedPath(entry.path)) continue;
      if (!['100644', '100755'].includes(String(entry.mode))) throw new Error('远端文档包含链接或 gitlink，无法同步。');
      if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES) throw new Error('远端文件超过 20 MiB 或大小响应无效。');
      files[entry.path] = { sha: sha(entry.sha), size: entry.size };
    }
    if (new Set(paths).size !== paths.length) throw new Error('远端文件树响应包含重复路径。');
    checkPaths(paths);
    return { head, tree, files, paths };
  }
  async blob(file: BaselineFile): Promise<Uint8Array> {
    const id = sha(file.sha);
    const result = await this.call('GET', `blobs/${id}`);
    if (sha(result.sha) !== id || result.encoding !== 'base64' || typeof result.content !== 'string' || result.size !== file.size) throw new Error('GitHub 文件响应无效。');
    const bytes = fromBase64(result.content);
    if (bytes.length !== file.size || await blobSha(bytes) !== id) throw new Error('GitHub 文件响应的大小或内容校验失败。');
    return bytes;
  }
  async createBlob(bytes: Uint8Array): Promise<string> {
    checkBytes(bytes);
    budget(bytes.length);
    const id = sha((await this.call('POST', 'blobs', { content: toBase64(bytes), encoding: 'base64' })).sha);
    if (id !== await blobSha(bytes)) throw new Error('GitHub 上传内容校验失败。');
    return id;
  }
  async createTree(base: string, files: { path: string; sha: string | null }[]): Promise<string> {
    return sha((await this.call('POST', 'trees', { base_tree: sha(base), tree: files.map(file => {
      if (!allowedPath(file.path)) throw new Error('上传路径不在允许范围内。');
      return { path: file.path, mode: '100644', type: 'blob', sha: file.sha === null ? null : sha(file.sha) };
    }) })).sha);
  }
  async createCommit(tree: string, parent: string, message: string): Promise<string> {
    if (!message.trim() || message.length > 1000 || message.includes('\0')) throw new Error('提交说明无效。');
    checkSecret(message);
    const result = await this.call('POST', 'commits', { tree: sha(tree), parents: [sha(parent)], message });
    if (sha(object(result.tree).sha) !== tree || !Array.isArray(result.parents) || result.parents.length !== 1 || sha(object(result.parents[0]).sha) !== parent) throw new Error('GitHub 提交响应的文件树或父提交不匹配。');
    return sha(result.sha);
  }
  async updateRef(commit: string): Promise<void> {
    const result = await this.call('PATCH', `refs/heads/${this.branch.split('/').map(encodeURIComponent).join('/')}`, { sha: sha(commit), force: false });
    if (sha(object(result.object).sha) !== commit || object(result.object).type !== 'commit') throw new Error('GitHub 分支更新响应无效，请重新检查。');
  }
}
