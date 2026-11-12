import { FolderPlusIcon } from "lucide-react";
import { useState, type DragEvent, type ReactNode } from "react";

import { splitTransferredFiles } from "../chat/workspaceFileDrop";
import { setFileDragActive } from "../Sidebar.logic";
import { toastManager } from "../ui/toast";
import { stackedThreadToast } from "../ui/toastHelpers";

function isFileDrag(event: DragEvent) {
  return event.dataTransfer.types.includes("Files");
}

/**
 * Folders dropped from the OS file manager open as projects, like `t3 <dir>`.
 * Thread rows take file drops for themselves by calling preventDefault first;
 * this zone then stays hidden and only picks up folders from the drop.
 * Browsers expose no absolute paths, so only the desktop app can add them.
 *
 * Coder: there is no desktop app, and a folder on this computer is not in the Coder workspace,
 * so a dropped folder always takes upstream's browser branch: a toast pointing at Add project.
 */
export function SidebarFolderDrop(props: { children: ReactNode }) {
  const [isActive, setIsActive] = useState(false);
  const setActive = (active: boolean) => setFileDragActive(setIsActive, active);

  const addFolders = () => {
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: "Folders on this computer can't be added",
        description:
          "Projects live in a Coder workspace. Use Add project to choose a folder there.",
      }),
    );
  };

  const onDragOver = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    if (event.defaultPrevented) {
      setActive(false);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setActive(true);
  };

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!isFileDrag(event)) return;
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setActive(false);
      }}
      onDrop={(event) => {
        if (!isFileDrag(event)) return;
        const claimedByRow = event.defaultPrevented;
        event.preventDefault();
        setActive(false);
        const { files, folders } = splitTransferredFiles(event.dataTransfer);
        if (folders.length > 0) addFolders();
        if (files.length > 0 && !claimedByRow) {
          // Coder: upstream's title says folders can be added, which the folder toast contradicts.
          toastManager.add(
            stackedThreadToast({
              type: "info",
              title: "Files attach to threads",
              description: "Drop files on a thread to attach them.",
            }),
          );
        }
      }}
    >
      {props.children}
      {isActive ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-1.5 z-30 flex flex-col items-center justify-center gap-2 rounded-lg px-4 text-center bg-sidebar/90 text-sm text-sidebar-foreground ring-1 ring-inset ring-primary/70"
        >
          <FolderPlusIcon className="size-5 text-sidebar-muted-foreground" />
          Use Add project to add a workspace folder
        </div>
      ) : null}
    </div>
  );
}
