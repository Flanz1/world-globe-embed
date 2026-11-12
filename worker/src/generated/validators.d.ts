/** Schema validators generated from schema/*.json (see scripts/build-worker-validators.ts). */
export interface ValidateFn {
  (data: unknown): boolean;
  errors?: { instancePath: string; message?: string; keyword: string }[] | null;
}
export const validateRegion: ValidateFn;
export const validateAccess: ValidateFn;
