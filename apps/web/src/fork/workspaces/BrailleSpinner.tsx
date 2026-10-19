import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { cn } from "../../lib/utils";
import "./workspaces.css";

/** Marks a chat or workspace whose agent is working. */
export function BrailleSpinner({ className }: { className?: string }) {
  return (
    <span
      ref={observeVisibleAnimation}
      role="img"
      aria-label="Working"
      data-fork-braille-spinner=""
      className={cn(
        "inline-flex w-3.5 shrink-0 justify-center font-mono text-primary leading-none",
        className,
      )}
    />
  );
}
