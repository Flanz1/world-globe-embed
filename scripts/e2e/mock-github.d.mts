/** Types for mock-github.mjs (an in-memory GitHub for tests). */
export const ACCOUNTS: { id: number; login: string; type: string }[];
export function blobSha(buf: Buffer): string;
export class MockGitHub {
  constructor(o: { repo?: string; root: string; branches?: string[]; defaultBranch?: string; maxBlobRequest?: number });
  refs: Map<string, string>;
  log: { branch: string; sha: string; message: string; changes: { path: string; deleted: boolean }[] }[];
  commits: Map<string, { message: string; tree: string; parent: string | null; author: string; date: string }>;
  read(branch: string, path: string): string | null;
  externalWrite(branch: string, path: string, text: string): void;
  oauthCode(login: string): string;
  handle(route: unknown): Promise<void>;
}
export function mockFetch(mock: MockGitHub): (url: string, init?: RequestInit) => Promise<Response>;
