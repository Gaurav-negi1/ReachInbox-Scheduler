/** Attachment chips shown in Compose (removable) and Detail (downloadable). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileCard({
  name,
  size,
  onRemove,
  onDownload,
}: {
  name: string;
  size?: number;
  onRemove?: () => void;
  onDownload?: () => void;
}) {
  const ext = name.includes(".") ? name.split(".").pop()!.toUpperCase().slice(0, 4) : "FILE";
  const inner = (
    <>
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-100 text-[10px] font-bold text-brand-700">
        {ext}
      </div>
      <div className="min-w-0">
        <div className="max-w-[180px] truncate text-sm font-medium text-gray-800">{name}</div>
        {size !== undefined && <div className="text-xs text-gray-400">{formatBytes(size)}</div>}
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="ml-1 text-gray-400 transition hover:text-gray-700"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
      {onDownload && (
        <button
          type="button"
          onClick={onDownload}
          aria-label={`Download ${name}`}
          className="ml-1 rounded-full px-2 py-0.5 text-xs font-medium text-brand-600 transition hover:bg-brand-50"
        >
          Download
        </button>
      )}
    </>
  );
  const cls =
    "flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-3 py-2 shadow-sm transition hover:border-brand-200";
  return <div className={cls}>{inner}</div>;
}
