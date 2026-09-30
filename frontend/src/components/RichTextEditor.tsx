import { useEffect, useRef } from "react";

/**
 * Lightweight rich-text editor on contentEditable (same approach as a minimal
 * editor: execCommand + toolbar). Emits HTML; EmailDetail sanitizes with
 * DOMPurify before rendering, and the plain-text fallback is derived via
 * stripHtml().
 */
const TOOLS: ({ cmd: string; arg?: string; label: string; d: string } | "sep")[] = [
  { cmd: "undo", label: "Undo", d: "M9 14l-4-4 4-4M5 10h11a3 3 0 010 6h-1" },
  { cmd: "redo", label: "Redo", d: "M14 6l4 4-4 4M19 10H8a3 3 0 000 6h1" },
  "sep",
  { cmd: "bold", label: "Bold", d: "M7 5h6a3.5 3.5 0 010 7H7zm0 7h7a3.5 3.5 0 010 7H7z" },
  { cmd: "italic", label: "Italic", d: "M10 5h8M6 19h8M14 5l-4 14" },
  { cmd: "underline", label: "Underline", d: "M7 4v7a5 5 0 0010 0V4M5 20h14" },
  { cmd: "strikeThrough", label: "Strikethrough", d: "M5 12h14M8 8a4 4 0 018 0M16 16a4 4 0 01-8 0" },
  "sep",
  { cmd: "insertUnorderedList", label: "Bulleted list", d: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" },
  { cmd: "insertOrderedList", label: "Numbered list", d: "M10 6h10M10 12h10M10 18h10M4 6l1.5-.5V10M4 14.5q1.5-1 2 .5t-2 3h2.5" },
  "sep",
  { cmd: "formatBlock", arg: "blockquote", label: "Quote", d: "M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" },
];

export function stripHtml(html: string): string {
  const el = document.createElement("div");
  el.innerHTML = html;
  return (el.textContent ?? "").replace(/\u00a0/g, " ").trim();
}

export function RichTextEditor({
  value,
  onChange,
  placeholder = "Type Your Reply...",
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Keep external resets (e.g. after submit) in sync without clobbering typing.
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== value && !ref.current.innerHTML && !value) return;
    if (ref.current && value === "" && ref.current.innerHTML !== "") ref.current.innerHTML = "";
  }, [value]);

  const run = (cmd: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, arg);
    onChange(ref.current?.innerHTML ?? "");
  };

  return (
    <div className="flex min-h-[320px] flex-col overflow-hidden rounded-xl bg-gray-100/70">
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline
        aria-label="Email body"
        data-placeholder={placeholder}
        onInput={() => onChange(ref.current?.innerHTML ?? "")}
        onBlur={() => onChange(ref.current?.innerHTML ?? "")}
        className="editor min-h-[120px] flex-1 px-4 py-3 text-sm leading-relaxed text-gray-800 outline-none"
      />
      <div className="m-2 flex flex-wrap items-center gap-0.5 rounded-full bg-white px-2 py-1" role="toolbar" aria-label="Formatting">
        {TOOLS.map((t, i) =>
          t === "sep" ? (
            <span key={i} className="mx-1.5 h-5 w-px bg-gray-200" />
          ) : (
            <button
              key={t.cmd + (t.arg ?? "")}
              type="button"
              aria-label={t.label}
              title={t.label}
              onMouseDown={(e) => {
                e.preventDefault(); // keep editor selection
                run(t.cmd, t.arg);
              }}
              className="rounded-md p-1.5 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
                <path strokeLinecap="round" strokeLinejoin="round" d={t.d} />
              </svg>
            </button>
          )
        )}
      </div>
    </div>
  );
}
