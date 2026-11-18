export const ALL: string[];
export const QUARANTINED: Record<string, string>;
export const GROUPS: Record<string, string[]>;
export const SUITE_ROOTS: Record<string, string[]>;
export function readSuites(dir?: string): { name: string; roots: string[]; editor: boolean; weight: number; quarantine: string }[];
export function select(files: string[]): string[];
