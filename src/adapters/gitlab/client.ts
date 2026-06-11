import { UsageError, redact, registerSecret } from "../../errors.ts";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GitLabClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: FetchLike;
}

export class GitLabHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

interface RestOptions {
  method?: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** Follow x-next-page across pages and concatenate array results. */
  paginate?: boolean;
}

/**
 * Authenticated GitLab HTTP client (REST /api/v4 + GraphQL /api/graphql).
 * The token travels only in the Authorization header — never in argv, URLs,
 * logs, or error messages (all errors pass through redact()).
 */
export class GitLabClient {
  private baseUrl: string;
  private token: string;
  private fetchImpl: FetchLike;

  constructor(opts: GitLabClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    registerSecret(this.token);
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          // FormData bodies must let fetch set the multipart boundary itself.
          ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
          ...(init.headers ?? {}),
        },
      });
    } catch (e) {
      throw new UsageError(redact(`request to ${url} failed: ${(e as Error).message}`));
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new GitLabHttpError(
        res.status,
        redact(`GitLab API ${init.method ?? "GET"} ${url} → ${res.status}: ${body.slice(0, 500)}`),
      );
    }
    return res;
  }

  async rest<T>(path: string, opts: RestOptions = {}): Promise<T> {
    const makeUrl = (page?: number): string => {
      const url = new URL(`${this.baseUrl}/api/v4/${path.replace(/^\//, "")}`);
      for (const [k, v] of Object.entries(opts.query ?? {})) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
      if (opts.paginate) {
        url.searchParams.set("per_page", "100");
        if (page) url.searchParams.set("page", String(page));
      }
      return url.toString();
    };
    const init: RequestInit = {
      method: opts.method ?? "GET",
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    };

    if (!opts.paginate) {
      const res = await this.request(makeUrl(), init);
      const text = await res.text();
      return (text.trim() ? JSON.parse(text) : null) as T;
    }

    const all: unknown[] = [];
    let page: number | undefined;
    for (let i = 0; i < 100; i++) {
      const res = await this.request(makeUrl(page), init);
      const chunk = (await res.json()) as unknown[];
      all.push(...chunk);
      const next = res.headers.get("x-next-page");
      if (!next) break;
      page = Number(next);
    }
    return all as T;
  }

  /** Multipart POST (file uploads). */
  async upload<T>(path: string, form: FormData): Promise<T> {
    const url = `${this.baseUrl}/api/v4/${path.replace(/^\//, "")}`;
    const res = await this.request(url, { method: "POST", body: form });
    return (await res.json()) as T;
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.request(`${this.baseUrl}/api/graphql`, {
      method: "POST",
      body: JSON.stringify({ query, variables }),
    });
    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (json.errors?.length) {
      throw new UsageError(redact(`GraphQL: ${json.errors.map((e) => e.message).join("; ")}`));
    }
    if (json.data === undefined) throw new UsageError("GraphQL: empty response");
    return json.data;
  }
}
