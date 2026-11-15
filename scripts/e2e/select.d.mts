export const ALL: string[];
export const GROUPS: Record<string, string[]>;
export const SUITE_ROOTS: Record<string, string[]>;
export function readSuites(dir?: string): { name: string; roots: string[]; editor: boolean; weight: number }[];
export function select(files: string[]): string[];
