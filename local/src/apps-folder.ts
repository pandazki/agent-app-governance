// Whether the Host sees the apps folder on the person's computer, or an empty folder that Docker made instead.
//
// A bind mount of a folder that Docker's virtual machine does not share (colima shares only the home folder unless
// told otherwise) does not fail: the VM makes an empty folder of the same name and mounts that. Apps created there
// would never appear in the person's folder and would go with the VM. So the folder carries a marker that only the
// person's side writes: git puts it in local/apps (it is tracked), and the checkout's CLI writes it into a folder of
// the person's own (APPGOV_APPS_DIR) that lacks it. The Host never writes it. Where the Host does not see it, it says
// so at start, in its health answer (which list and status print), and refuses to create an app.
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The marker's name, in the apps folder. bin/appgov.mjs names it too; a test checks the two agree. */
export const HOST_FOLDER_MARKER = ".appgov-host-folder";

/** Whether the apps directory as this process sees it holds the marker written on the person's side. */
export function seesHostFolder(appsDir: string): boolean {
  return existsSync(join(appsDir, HOST_FOLDER_MARKER));
}

/** What the Host says when it does not see the folder: the fault, what follows from it, the usual cause, and what to do. */
export function notSeenText(appsFolder: string): string {
  return (
    `this Host does not see the apps folder ${appsFolder} on your computer: it has no ${HOST_FOLDER_MARKER}, which that folder holds. ` +
    "The container sees an empty folder that Docker made inside its virtual machine instead, so an app created now would not be in your folder and would be lost with that machine. " +
    "Creating apps is refused until the Host sees the folder. The usual cause is colima, which shares only your home folder unless told otherwise. " +
    `Clone under your home folder, or share ${appsFolder} with Docker's virtual machine, then run docker compose up -d again in local/. ` +
    `For a folder of your own (APPGOV_APPS_DIR), the file ${HOST_FOLDER_MARKER} must be in it: running node bin/appgov.mjs list in local/ writes it.`
  );
}
