"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CheckCheck, Mail, RefreshCw, Unplug, X } from "lucide-react";
import { useEffect } from "react";
import { useToast } from "@/components/toast";
import { Badge, Button, Card, CardHeader } from "@/components/ui";
import { api, type GmailStatus, type TrackerView } from "@/lib/api";
import { relativeTime } from "@/lib/utils";
import { STAGE_LABEL } from "./stages";

/** What `?gmail=` on the way back from Google means, as the person should hear it. */
const OUTCOME: Record<string, { ok: boolean; text: string }> = {
  connected: {
    ok: true,
    text: "Gmail connected. Reading the last 30 days now - suggestions appear here in a minute.",
  },
  denied: { ok: false, text: "Gmail was not connected - access was declined." },
  scope: {
    ok: false,
    text: 'Gmail was not connected: the "read your email" box was unticked on Google\'s screen, and sync cannot work without it.',
  },
  expired: {
    ok: false,
    text: "That sign-in link expired. Press Connect again.",
  },
  failed: {
    ok: false,
    text: "Connecting Gmail failed. Try again in a moment.",
  },
  "not-configured": {
    ok: false,
    text: "Gmail sync is not set up on this server.",
  },
};

/**
 * Gmail sync: the one part of the tracker that reads something the candidate did not type.
 *
 * IT ONLY EVER SUGGESTS. Each card is one email's claim - "Atlassian: interview" with the
 * sentence that says so - and the tracker changes only when Apply is pressed. That keeps
 * the promise in the page header true: every row is still something you put there, some
 * of them with one click instead of a form.
 */
export function GmailPanel({
  onSettled,
}: {
  onSettled: (next: TrackerView) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();

  const status = useQuery({
    queryKey: ["me", "gmail"],
    queryFn: () => api.get<GmailStatus>("/api/me/gmail"),
    // The first pass after connecting runs in the background; poll until it lands.
    refetchInterval: (q) =>
      q.state.data?.connected && !q.state.data.lastSyncedAt ? 5000 : false,
  });

  const put = (next: GmailStatus) => qc.setQueryData(["me", "gmail"], next);

  // Read once and then cleared, so a reload does not toast again. window rather than
  // useSearchParams, which would put the whole tracker behind a Suspense boundary.
  useEffect(() => {
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get("gmail");
    if (!outcome) return;
    const said = OUTCOME[outcome];
    if (said?.ok) toast.success(said.text);
    else if (said) toast.error(said.text);
    url.searchParams.delete("gmail");
    window.history.replaceState(null, "", url.toString());
  }, [toast]);

  const connect = useMutation({
    mutationFn: () => api.post<{ url: string }>("/api/me/gmail/connect"),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const sync = useMutation({
    mutationFn: () => api.post<GmailStatus>("/api/me/gmail/sync"),
    onSuccess: (next) => {
      put(next);
      toast.success(
        next.suggestions.length > 0
          ? `Synced. ${next.suggestions.length} suggestion(s) waiting.`
          : "Synced. Nothing new.",
      );
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const disconnect = useMutation({
    mutationFn: () => api.del<GmailStatus>("/api/me/gmail"),
    onSuccess: (next) => {
      put(next);
      toast.success("Gmail disconnected, and Google access revoked.");
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const apply = useMutation({
    mutationFn: (id: string) =>
      api.post<{ tracker: TrackerView; gmail: GmailStatus }>(
        `/api/me/gmail/suggestions/${id}/apply`,
      ),
    onSuccess: ({ tracker, gmail }) => {
      onSettled(tracker);
      put(gmail);
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const applyAll = useMutation({
    mutationFn: () =>
      api.post<{ tracker: TrackerView; gmail: GmailStatus; failed: number }>(
        "/api/me/gmail/suggestions/apply-all",
      ),
    onSuccess: ({ tracker, gmail, failed }) => {
      onSettled(tracker);
      put(gmail);
      if (failed > 0)
        toast.error(`${failed} could not be applied and are still listed.`);
      else toast.success("All applied.");
    },
    onError: (err) => toast.error((err as Error).message),
  });

  const dismiss = useMutation({
    mutationFn: (id: string) =>
      api.post<GmailStatus>(`/api/me/gmail/suggestions/${id}/dismiss`),
    onSuccess: put,
    onError: (err) => toast.error((err as Error).message),
  });

  const s = status.data;
  if (!s) return null;

  if (!s.configured) {
    return (
      <Card>
        <CardHeader
          icon={Mail}
          title="Update from Gmail"
          subtitle="Not set up on this server. It needs a Google OAuth client - see “Gmail sync” in the README - and then each person connects their own inbox, read-only."
        />
      </Card>
    );
  }

  if (!s.connected) {
    return (
      <Card>
        <CardHeader
          icon={Mail}
          title="Update from Gmail"
          subtitle="Connect your inbox read-only and recruiter emails - “thanks for applying”, interview invites, rejections - become suggested updates here. Nothing changes until you press Apply, and only the subject and one quoted sentence are kept."
          action={
            <Button
              variant="primary"
              size="sm"
              icon={Mail}
              busy={connect.isPending}
              onClick={() => connect.mutate()}
            >
              Connect Gmail
            </Button>
          }
        />
      </Card>
    );
  }

  const busy = apply.isPending || applyAll.isPending || dismiss.isPending;

  return (
    <Card glow={s.suggestions.length > 0}>
      <CardHeader
        icon={Mail}
        title="Update from Gmail"
        subtitle={`${s.email} · ${
          s.lastSyncedAt
            ? `last read ${relativeTime(s.lastSyncedAt)}`
            : "reading now…"
        } · checked hourly`}
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              icon={RefreshCw}
              busy={sync.isPending}
              onClick={() => sync.mutate()}
            >
              Sync now
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon={Unplug}
              busy={disconnect.isPending}
              onClick={() => {
                if (window.confirm("Disconnect Gmail and revoke access?"))
                  disconnect.mutate();
              }}
            >
              Disconnect
            </Button>
          </div>
        }
      />

      <div className="space-y-3 px-5 py-4">
        {s.lastError && (
          <p className="text-xs text-[var(--status-critical)]">{s.lastError}</p>
        )}

        {s.suggestions.length === 0 ? (
          <p className="text-xs text-[var(--ink-muted)]">
            No suggestions waiting. New recruiter mail shows up here after the
            next read.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-[var(--ink-muted)]">
                {s.suggestions.length} suggestion
                {s.suggestions.length === 1 ? "" : "s"} from your inbox. Check
                each against its quote before applying.
              </p>
              {s.suggestions.length > 1 && (
                <Button
                  size="sm"
                  icon={CheckCheck}
                  busy={applyAll.isPending}
                  disabled={busy}
                  onClick={() => applyAll.mutate()}
                >
                  Apply all
                </Button>
              )}
            </div>

            <ul className="divide-y divide-[var(--border)]">
              {s.suggestions.map((g) => (
                <li
                  key={g.id}
                  className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm text-[var(--ink-primary)]">
                      <span className="font-medium">{g.company}</span>
                      {g.role && (
                        <span className="text-[var(--ink-secondary)]">
                          · {g.role}
                        </span>
                      )}
                      {g.application ? (
                        <Badge tone="accent">
                          {STAGE_LABEL[g.application.stage]} →{" "}
                          {STAGE_LABEL[g.proposedStage]}
                        </Badge>
                      ) : (
                        <Badge tone="good">
                          New · {STAGE_LABEL[g.proposedStage]}
                        </Badge>
                      )}
                    </p>
                    <p className="text-xs text-[var(--ink-secondary)] italic">
                      “{g.evidence}”
                    </p>
                    <p className="truncate text-xs text-[var(--ink-muted)]">
                      {g.subject} · {g.fromAddress} ·{" "}
                      {relativeTime(g.receivedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      icon={Check}
                      disabled={busy}
                      busy={apply.isPending && apply.variables === g.id}
                      onClick={() => apply.mutate(g.id)}
                    >
                      Apply
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={X}
                      disabled={busy}
                      busy={dismiss.isPending && dismiss.variables === g.id}
                      onClick={() => dismiss.mutate(g.id)}
                    >
                      Dismiss
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Card>
  );
}
