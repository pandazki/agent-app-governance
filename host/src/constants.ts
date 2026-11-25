// ---------------------------------------------------------------------------
// Fixed strings of the Host that code reading its answers matches on. No
// imports: the owner page's model (local/src/page-views.ts) runs in the
// Cloudflare edition's Worker too, where the rest of the Host does not.
// ---------------------------------------------------------------------------

/**
 * The directory, directly under every app directory and under the directory that holds the apps, where this
 * Host keeps its own files: the app's identity, waiting changes, drafts, the CLI copy and the recorded
 * address. The CLI in bin/ names the same directory on its own, because it runs without this code; a test
 * checks the two agree.
 */
export const STATE_DIR = ".appgov";

/**
 * How a governed change's `one_way` reason marks the part its submitter declared (`submit --one-way`): after what the
 * rules found, joined with "; ", this prefix and the submitter's words in double quotes. The owner page tells the
 * rules' finding from the declaration by it.
 */
export const DECLARED_ONE_WAY_MARK = "declared one-way when it was submitted: ";

/** What to do in each case, said the same way by status and by the refusal. The owner page tells the two cases apart by it. */
export const RUN_UNDO = "Submit and approve are refused until an undo puts a version on the address and sees it answer: run undo.";
