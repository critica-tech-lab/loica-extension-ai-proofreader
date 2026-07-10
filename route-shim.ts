/**
 * Shim route source for the AI Proofreader extension.
 *
 * Copy to `app/routes/api.proofread.$id.ts` in the host (git-ignored there).
 * React Router only splits route modules physically under `app/`, and this
 * extension is symlinked in from an out-of-root repo — so the real `action` (in
 * `proofread.ts`, importing server-only `~/lib/*`) can't be a route module
 * directly. This thin re-export is a real file under `app/routes/`, so RR marks
 * it server-only.
 */
export { action } from "~/extensions/ai-proofreader/proofread";
