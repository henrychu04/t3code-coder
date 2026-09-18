import { useRef } from "react";
import { PaperclipIcon } from "lucide-react";
import { Button } from "../ui/button";

/** All entry points feed the same draft upload queue and signature-validated transfer. */
export function ComposerImagePicker({
  disabled,
  onFiles,
}: {
  disabled?: boolean;
  onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        aria-label="Choose images"
        disabled={disabled}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length) onFiles(files);
        }}
      />
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        disabled={disabled}
        aria-label="Attach images"
        title="Attach images (PNG, JPEG, WebP)"
        onClick={() => input.current?.click()}
      >
        <PaperclipIcon aria-hidden />
      </Button>
    </>
  );
}
