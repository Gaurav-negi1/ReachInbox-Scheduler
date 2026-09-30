import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { Sidebar } from "../components/Sidebar";
import { EmailList } from "../components/EmailList";
import { ComposePage } from "../components/ComposePage";
import { EmailDetail } from "../components/EmailDetail";
import type { ListFilter } from "../components/FilterMenu";
import type { ScheduledEmail } from "../types";

type Tab = "scheduled" | "sent";
type View = { name: "list" } | { name: "compose" } | { name: "detail"; email: ScheduledEmail };

export function Dashboard() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>("scheduled");
  const [view, setView] = useState<View>({ name: "list" });
  const [scheduled, setScheduled] = useState<ScheduledEmail[]>([]);
  const [sent, setSent] = useState<ScheduledEmail[]>([]);
  const [scheduledTotal, setScheduledTotal] = useState(0);
  const [sentTotal, setSentTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ListFilter>("all");
  const [toast, setToast] = useState<{ message: string; kind: "success" | "error" | "info" } | null>(null);

  const showToast = useCallback((message: string, kind: "success" | "error" | "info") => {
    setToast({ message, kind });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { search: search || undefined, filter, pageSize: 100 };
      if (tab === "scheduled") {
        const res = await api.scheduled(params);
        setScheduled(res.items);
        setScheduledTotal(res.total);
      } else {
        const res = await api.sent(params);
        setSent(res.items);
        setSentTotal(res.total);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to load emails", "error");
    } finally {
      setLoading(false);
    }
  }, [tab, search, filter, showToast]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 250); // debounce search
    return () => clearTimeout(t);
  }, [load]);

  // Silent poll: rows flip Scheduled -> Sent (and counts update) live, without
  // a manual refresh — same tab/filter/search, never shows the skeleton.
  useEffect(() => {
    const t = setInterval(() => {
      if (view.name !== "list" || document.hidden) return;
      void load();
    }, 10_000);
    return () => clearInterval(t);
  }, [load, view.name]);

  // Keep counts on both nav rows fresh even when viewing the other tab.
  useEffect(() => {
    api
      .scheduled({ pageSize: 1 })
      .then((r) => setScheduledTotal(r.total))
      .catch(() => undefined);
    api
      .sent({ pageSize: 1 })
      .then((r) => setSentTotal(r.total))
      .catch(() => undefined);
  }, [view]);

  const cancel = async (id: string) => {
    try {
      await api.cancel(id);
      showToast("Email cancelled", "success");
      setView({ name: "list" });
      void load();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Cancel failed", "error");
    }
  };

  if (!user) return null;

  const items = tab === "scheduled" ? scheduled : sent;

  return (
    <div className="flex h-screen overflow-hidden bg-white">
      <Sidebar
        active={tab}
        scheduledCount={scheduledTotal}
        sentCount={sentTotal}
        onNavigate={(t) => {
          setTab(t);
          setSearch("");
          setFilter("all");
          setView({ name: "list" });
        }}
        onCompose={() => setView({ name: "compose" })}
      />

      {view.name === "list" && (
        <EmailList
          items={items}
          loading={loading}
          mode={tab}
          search={search}
          filter={filter}
          onSearchChange={setSearch}
          onFilterChange={setFilter}
          onRefresh={() => void load()}
          onOpen={(email) => setView({ name: "detail", email })}
          onToggleStar={(id, next) => {
            const upd = (list: ScheduledEmail[]) =>
              list.map((e) => (e.id === id ? { ...e, starred: next } : e));
            setScheduled(upd);
            setSent(upd);
          }}
          toast={showToast}
        />
      )}

      {view.name === "compose" && (
        <ComposePage
          onBack={() => setView({ name: "list" })}
          onScheduled={() => {
            setTab("scheduled");
            setView({ name: "list" });
            void load();
          }}
          toast={showToast}
        />
      )}

      {view.name === "detail" && (
        <EmailDetail email={view.email} onBack={() => setView({ name: "list" })} onCancel={(id) => void cancel(id)} />
      )}

      {toast && (
        <div className="fixed bottom-5 right-5 z-[70]">
          <div
            className={`rounded-lg px-4 py-3 text-sm text-white shadow-lg ${
              toast.kind === "success" ? "bg-brand-600" : toast.kind === "error" ? "bg-red-600" : "bg-gray-800"
            }`}
          >
            {toast.message}
          </div>
        </div>
      )}
    </div>
  );
}
