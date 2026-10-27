import { useEffect, useRef, useState } from "react";

import { useTheme } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";
import { cn } from "../../lib/utils";

type Highlighter = Awaited<ReturnType<typeof getSyntaxHighlighterPromise>>;

// Both layers share these so the highlighted text sits exactly under the caret.
const SHARED_TEXT =
  "m-0 whitespace-pre-wrap break-words p-2.5 font-mono text-xs leading-5 [tab-size:2]";

/**
 * A plain textarea over highlighted text, using upstream's shared Shiki
 * highlighter. Plain text shows until the bash grammar loads.
 */
export function BashEditor(props: {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  label: string;
  placeholder?: string;
  minRows?: number;
}) {
  const { resolvedTheme } = useTheme();
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);
  const highlightRef = useRef<HTMLPreElement>(null);

  // oxlint-disable-next-line t3code/react-effect-budget -- Loads the shared highlighter asynchronously; ignores a load that resolves after unmount.
  useEffect(() => {
    let active = true;
    void getSyntaxHighlighterPromise("bash").then((loaded) => {
      if (active) setHighlighter(loaded);
    });
    return () => {
      active = false;
    };
  }, []);

  const lines = highlighter
    ? highlighter.codeToTokens(props.value, {
        lang: "bash",
        theme: resolveDiffThemeName(resolvedTheme),
      }).tokens
    : null;

  return (
    <div className="relative overflow-hidden rounded-md border border-input bg-background">
      <pre
        ref={highlightRef}
        aria-hidden
        className={cn(
          SHARED_TEXT,
          "pointer-events-none absolute inset-0 overflow-hidden text-foreground",
        )}
      >
        {lines
          ? lines.map((tokens, lineIndex) => (
              // eslint-disable-next-line react/no-array-index-key -- lines have no identity beyond their position.
              <span key={lineIndex}>
                {tokens.map((token, tokenIndex) => (
                  // eslint-disable-next-line react/no-array-index-key -- tokens are positional too.
                  <span key={tokenIndex} style={{ color: token.color }}>
                    {token.content}
                  </span>
                ))}
                {"\n"}
              </span>
            ))
          : null}
        {/* A trailing newline needs a line to show on, like the textarea does. */}{" "}
      </pre>
      <textarea
        aria-label={props.label}
        value={props.value}
        placeholder={props.placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        rows={props.minRows ?? 8}
        onChange={(event) => props.onChange(event.target.value)}
        onBlur={props.onBlur}
        onScroll={(event) => {
          const pre = highlightRef.current;
          if (pre) {
            pre.scrollTop = event.currentTarget.scrollTop;
            pre.scrollLeft = event.currentTarget.scrollLeft;
          }
        }}
        className={cn(
          SHARED_TEXT,
          "relative block w-full resize-y bg-transparent text-transparent caret-foreground outline-none selection:bg-primary/25 placeholder:text-muted-foreground/60",
          lines === null && "text-foreground",
        )}
      />
    </div>
  );
}
