import { useEffect, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  readProjectMediaBlob,
  type ProjectImageTarget,
  type ProjectMediaKind,
} from "../../lib/readProjectImageBlob";

/** A workspace media file the helper reads for one environment. */
export interface ProjectMediaSource {
  readonly environmentId: EnvironmentId;
  readonly target: ProjectImageTarget;
}
export type ProjectVideoSource = ProjectMediaSource;

type ProjectVideoState =
  | { readonly status: "idle" | "failed" }
  | { readonly status: "loading"; readonly loaded: number; readonly total: number }
  | { readonly status: "loaded"; readonly src: string };

/** Loads one workspace media file into a blob URL that lives exactly as long as the caller. */
export function useProjectMedia(
  kind: ProjectMediaKind,
  source: ProjectVideoSource | undefined,
  enabled: boolean,
) {
  const read = useAtomCommand(projectEnvironment.readImage, { reportFailure: false });
  const [state, setState] = useState<ProjectVideoState>({ status: "idle" });
  const [attempt, setAttempt] = useState(0);
  const serialized = source ? JSON.stringify(source) : null;

  useEffect(() => {
    if (!enabled || !serialized) return;
    const { environmentId, target } = JSON.parse(serialized) as ProjectVideoSource;
    const controller = new AbortController();
    let src: string | undefined;
    setState({ status: "loading", loaded: 0, total: 0 });
    readProjectMediaBlob(
      kind,
      target,
      async (input) => {
        const result = await read({ environmentId, input });
        if (result._tag !== "Success") throw squashAtomCommandFailure(result);
        return result.value;
      },
      controller.signal,
      (loaded, total) => {
        if (!controller.signal.aborted) setState({ status: "loading", loaded, total });
      },
    ).then(
      (blob) => {
        if (controller.signal.aborted) return;
        src = URL.createObjectURL(blob);
        setState({ status: "loaded", src });
      },
      () => {
        if (!controller.signal.aborted) setState({ status: "failed" });
      },
    );
    return () => {
      controller.abort();
      if (src) URL.revokeObjectURL(src);
    };
  }, [attempt, enabled, kind, serialized, read]);

  return {
    state,
    retry: async () => setAttempt((value) => value + 1),
  };
}

export function useProjectVideo(source: ProjectVideoSource | undefined, enabled: boolean) {
  return useProjectMedia("video", source, enabled);
}
