import { CapturedMarkdownImage, CapturedImageDialog } from "./CapturedMarkdownImage";
import type { ExpandedImagePreview } from "./ExpandedImageDialog";
import { markdownImageGallery } from "./markdownImageGallery";
import type { EnvironmentId, ScreenshotArtifactReference, TurnId } from "@t3tools/contracts";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

/** A one-shot request owned by the timeline, surviving gallery unmounts. */
export function createArtifactNavigationRequest(artifactId: string) {
  let consumed = false;
  return {
    artifactId,
    consume: () => {
      if (consumed) return false;
      consumed = true;
      return true;
    },
  };
}

export const ArtifactNavigationContext = createContext<{
  environmentId?: EnvironmentId;
  artifactsByTurn: ReadonlyMap<TurnId, ReadonlyArray<ScreenshotArtifactReference>>;
  reveal: (artifactId: string) => void;
  request: ReturnType<typeof createArtifactNavigationRequest> | null;
} | null>(null);
export const ArtifactTurnContext = createContext<TurnId | null>(null);

export function isImageFilePath(path: string): boolean {
  return /\.(?:png|jpe?g|webp|gif|svg|avif|bmp|ico|tiff?)$/i.test(path);
}

export async function findLinkedArtifact(
  relativePath: string,
  artifacts: ReadonlyArray<ScreenshotArtifactReference>,
): Promise<ScreenshotArtifactReference | undefined> {
  if (
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    relativePath.split("/").some((part) => !part || part === "." || part === "..")
  )
    return;
  for (const artifact of [...artifacts].reverse()) {
    if (!artifact.sourcePathKeys?.length) continue;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${artifact.id}\0${relativePath}`),
    );
    const key = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    if (artifact.sourcePathKeys.includes(key)) return artifact;
  }
}

const InsideArtifactLink = createContext(false);

export function ArtifactImageLink(props: {
  relativePath: string | null;
  children: ReactNode;
  inline?: boolean;
  alt?: string | undefined;
  width?: string | number | undefined;
  height?: string | number | undefined;
  standalone?: boolean | undefined;
  imageProps?: Omit<ComponentProps<"img">, "src" | "srcSet" | "alt" | "style"> | undefined;
  copyMarkdown?: string | undefined;
}) {
  const nested = useContext(InsideArtifactLink);
  if (nested && !props.inline) return <>{props.children}</>;
  return (
    <InsideArtifactLink value={true}>
      <ArtifactImageLinkContent {...props} />
    </InsideArtifactLink>
  );
}

function ArtifactImageLinkContent({
  relativePath,
  children,
  inline,
  alt,
  width,
  height,
  standalone,
  imageProps,
  copyMarkdown,
}: {
  relativePath: string | null;
  children: ReactNode;
  inline?: boolean;
  alt?: string | undefined;
  width?: string | number | undefined;
  height?: string | number | undefined;
  standalone?: boolean | undefined;
  imageProps?: Omit<ComponentProps<"img">, "src" | "srcSet" | "alt" | "style"> | undefined;
  copyMarkdown?: string | undefined;
}) {
  const navigation = useContext(ArtifactNavigationContext);
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  const turnId = useContext(ArtifactTurnContext);
  const artifacts = turnId ? navigation?.artifactsByTurn.get(turnId) : undefined;
  const [match, setMatch] = useState<{
    path: string;
    artifacts: typeof artifacts;
    id: string;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (relativePath && artifacts) {
      void findLinkedArtifact(relativePath, artifacts)
        .then((artifact) => {
          if (!cancelled)
            setMatch(artifact ? { path: relativePath, artifacts, id: artifact.id } : null);
        })
        .catch(() => {
          if (!cancelled) setMatch(null);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [relativePath, artifacts]);
  const id = match?.path === relativePath && match?.artifacts === artifacts ? match?.id : undefined;
  if (!id || !navigation)
    return (
      <span title="Image preview unavailable">
        {children}
        <span className="sr-only"> — Image preview unavailable</span>
      </span>
    );
  const artifact = artifacts?.find((artifact) => artifact.id === id);
  if (inline && artifact && navigation.environmentId)
    return (
      <CapturedMarkdownImage
        key={`${navigation.environmentId}:${id}`}
        environmentId={navigation.environmentId}
        artifact={artifact}
        alt={alt ?? artifact.name}
        width={width}
        height={height}
        standalone={standalone}
        imageProps={imageProps}
        copyMarkdown={copyMarkdown}
      />
    );
  if (inline) return <>{children}</>;
  return (
    <>
      <a
        href="#"
        className="cursor-pointer text-primary underline"
        title="Preview image"
        onClick={(event) => {
          event.preventDefault();
          if (!navigation.environmentId || !artifact) return navigation.reveal(id);
          const element = event.currentTarget.querySelector("img") ?? event.currentTarget;
          setPreview(markdownImageGallery(element, { src: null, name: artifact.name, artifact }));
        }}
      >
        {children}
      </a>
      {preview && navigation.environmentId ? (
        <CapturedImageDialog
          environmentId={navigation.environmentId}
          preview={preview}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </>
  );
}
