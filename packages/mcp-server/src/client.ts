/**
 * HTTP client for the CMS core-service REST API.
 * All methods throw on network errors; callers handle 404/not-found.
 */

export interface RepoHead {
  branch: string;
  commit_sha: string;
  indexed_at: string;
}

export interface RepoInfo {
  id: string;
  org: string;
  name: string;
  default_branch: string;
  primary_lang: string | null;
  created_at: string;
  heads: RepoHead[];
}

export interface SymbolResult {
  scip_symbol: string;
  display_name: string | null;
  kind: string | null;
  language: string | null;
  file_path: string;
  start_line: number | null;
  end_line: number | null;
  repo: string;
  commit_sha: string;
}

export interface OccurrenceInfo {
  file_path: string;
  start_line: number | null;
  start_col: number | null;
  end_line: number | null;
  end_col: number | null;
  role: number;
}

export interface SymbolDetail {
  symbol: {
    scip_symbol: string;
    display_name: string | null;
    kind: string | null;
    language: string | null;
    file_path: string;
    start_line: number | null;
    end_line: number | null;
    signature: string | null;
    doc: string | null;
  };
  repo: string;
  commit_sha: string;
  occurrences: OccurrenceInfo[];
}

export interface SearchParams {
  q: string;
  repo?: string;
  lang?: string;
  kind?: string;
  limit?: number;
}

export interface SymbolReferencesParams {
  repo?: string;
  include_definitions?: boolean;
  limit?: number;
}

export interface SymbolReferencesResult {
  scip_symbol: string;
  repo: string;
  commit_sha: string;
  total: number;
  truncated: boolean;
  occurrences: OccurrenceInfo[];
}

export interface FileOverviewParams {
  repo: string;
  file_path: string;
  commit?: string;
}

export interface FileSymbol {
  scip_symbol: string;
  display_name: string | null;
  kind: string | null;
  language: string | null;
  start_line: number | null;
  start_col: number | null;
  end_line: number | null;
  end_col: number | null;
  signature: string | null;
  doc: string | null;
}

export interface FileOverviewResult {
  repo: string;
  commit_sha: string;
  file_path: string;
  total: number;
  symbols: FileSymbol[];
}

export class CmsClient {
  private readonly base: string;
  private readonly token: string | undefined;

  constructor(endpoint: string, token?: string) {
    this.base = endpoint.replace(/\/$/, "");
    this.token = token;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }

  async listRepos(): Promise<{ repos: RepoInfo[] }> {
    const res = await fetch(`${this.base}/v1/repos`, { headers: this.headers() });
    if (!res.ok) throw new Error(`listRepos failed: ${res.status}`);
    return res.json() as Promise<{ repos: RepoInfo[] }>;
  }

  async searchSymbols(params: SearchParams): Promise<{ results: SymbolResult[]; total: number }> {
    const qs = new URLSearchParams({ q: params.q });
    if (params.repo) qs.set("repo", params.repo);
    if (params.lang) qs.set("lang", params.lang);
    if (params.kind) qs.set("kind", params.kind);
    if (params.limit != null) qs.set("limit", String(params.limit));

    const res = await fetch(`${this.base}/v1/search?${qs.toString()}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`searchSymbols failed: ${res.status}`);
    return res.json() as Promise<{ results: SymbolResult[]; total: number }>;
  }

  async getSymbolDetail(scipSymbol: string): Promise<SymbolDetail | null> {
    const qs = new URLSearchParams({ scip_symbol: scipSymbol });
    const res = await fetch(`${this.base}/v1/symbols?${qs.toString()}`, { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`getSymbolDetail failed: ${res.status}`);
    return res.json() as Promise<SymbolDetail>;
  }

  async getSymbolReferences(
    scipSymbol: string,
    params?: SymbolReferencesParams
  ): Promise<SymbolReferencesResult | null> {
    const qs = new URLSearchParams({ scip_symbol: scipSymbol });
    if (params?.repo) qs.set("repo", params.repo);
    if (params?.include_definitions) qs.set("include_definitions", "true");
    if (params?.limit != null) qs.set("limit", String(params.limit));
    const res = await fetch(
      `${this.base}/v1/symbols/references?${qs.toString()}`,
      { headers: this.headers() }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`getSymbolReferences failed: ${res.status}`);
    return res.json() as Promise<SymbolReferencesResult>;
  }

  async getFileOverview(
    params: FileOverviewParams
  ): Promise<FileOverviewResult | null> {
    const qs = new URLSearchParams({
      repo: params.repo,
      file_path: params.file_path,
    });
    if (params.commit) qs.set("commit", params.commit);
    const res = await fetch(
      `${this.base}/v1/files/overview?${qs.toString()}`,
      { headers: this.headers() }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`getFileOverview failed: ${res.status}`);
    return res.json() as Promise<FileOverviewResult>;
  }
}
