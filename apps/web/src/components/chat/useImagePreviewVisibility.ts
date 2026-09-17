import { useEffect, useState } from "react";

/** Release full-size preview bytes when the image scrolls away. */
export function useImagePreviewVisibility() {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return { previewRef: setElement, visible };
}
