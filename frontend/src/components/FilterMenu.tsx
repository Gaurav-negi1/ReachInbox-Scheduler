import { useEffect, useRef, useState } from "react";

export type ListFilter = "all" | "starred" | "failed";

const OPTIONS: { key: ListFilter; label: string; modes: ("scheduled" | "sent")[] }[] = [
  { key: "all", label: "All", modes: ["scheduled", "sent"] },
  { key: "starred", label: "Starred", modes: ["scheduled", "sent"] },
  { key: "failed", label: "Failed", modes: ["sent"] },
];

/** Filter dropdown next to the search bar: All / Starred (both tabs) / Failed (Sent). */
export function FilterMenu({
  mode,
  value,
  onChange,
}: {
  mode: "scheduled" | "sent";
  value: ListFilter;
  onChange: (f: ListFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const options = OPTIONS.filter((o) => o.modes.includes(mode));

  return (
    <div className="relative" ref={ref}>
      <button
        title="Filter"
        onClick={() => setOpen((o) => !o)}
        className={`rounded-full p-2 transition hover:bg-gray-100 ${
          value === "all" ? "text-gray-400 hover:text-gray-600" : "text-brand-600"
        }`}
      >
        <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" d="M4 6h16M7 12h10m-7 6h4" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-20 w-40 rounded-xl border border-gray-200 bg-white py-1 shadow-xl">
          {options.map((o) => (
            <button
              key={o.key}
              onClick={() => {
                onChange(o.key);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm transition hover:bg-gray-50 ${
                value === o.key ? "font-medium text-brand-600" : "text-gray-700"
              }`}
            >
              {o.label}
              {value === o.key && (
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
