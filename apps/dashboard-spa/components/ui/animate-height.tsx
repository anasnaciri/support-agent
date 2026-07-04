import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Animates its own height to follow the children's natural size, so content
 * that resolves from a skeleton to its real shape (or a row that appears /
 * disappears) grows or shrinks smoothly instead of jumping. Measures the inner
 * wrapper with a ResizeObserver and transitions the outer element's pixel
 * height; until the first measurement the height stays `auto`, so the initial
 * paint never animates from zero.
 */
export function AnimateHeight({
  children,
  className,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    setHeight(el.offsetHeight);
    const observer = new ResizeObserver(() => {
      setHeight(el.offsetHeight);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className={cn(
        "overflow-hidden transition-[height] duration-300 ease-in-out",
        className,
      )}
      style={{ height: height ?? "auto" }}
    >
      <div ref={innerRef}>{children}</div>
    </div>
  );
}
