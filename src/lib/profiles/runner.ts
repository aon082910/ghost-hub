import { checkGravatar, checkSite } from "./check";
import type { GetTransport } from "./http";
import { appliesTo, loadSites, openUrl } from "./sites";
import { connectedEmails, lastChecked, listUsernames, saveGravatarResult, saveSiteResult } from "./store";

const CONCURRENCY = 4;
/** An identifier checked more recently than this is skipped, so repeated clicks can't hammer other people's sites. */
export const COOLDOWN_MS = 10 * 60_000;

export type JobState = {
  running: boolean;
  total: number;
  done: number;
  found: number;
  errors: number;
  startedAt: number;
  finishedAt?: number;
  cancelled?: boolean;
};

type Job = JobState & { controller: AbortController };

// One job at a time. Kept on globalThis so dev hot reloads don't lose track of it.
const g = globalThis as unknown as { __ghostHubProfileJob?: Job };

export function getProfileJob(): JobState | null {
  const j = g.__ghostHubProfileJob;
  if (!j) return null;
  const { controller: _controller, ...state } = j;
  void _controller;
  return state;
}

export function cancelProfileScan(): boolean {
  const j = g.__ghostHubProfileJob;
  if (!j?.running) return false;
  j.cancelled = true;
  j.controller.abort();
  return true;
}

export type StartResult = { started: true; total: number; skippedRecent: number } | { started: false; reason: "running" | "nothing" | "recent"; skippedRecent: number };

type Task = () => Promise<"found" | "other" | "error">;

/**
 * Check every username you've added, and every connected email address, against public sources, in the background.
 * Identifiers checked in the last few minutes are skipped. Only your own identifiers are ever looked up: usernames
 * you confirmed are yours, and addresses of mailboxes you've connected.
 */
export async function startProfileScan(deps: { transport?: GetTransport; now?: Date } = {}): Promise<StartResult> {
  if (g.__ghostHubProfileJob?.running) return { started: false, reason: "running", skippedRecent: 0 };
  // Claim the slot before any await so two quick clicks can't start two jobs.
  const job: Job = { running: true, total: 0, done: 0, found: 0, errors: 0, startedAt: Date.now(), controller: new AbortController() };
  g.__ghostHubProfileJob = job;

  try {
    const now = deps.now ?? new Date();
    const usernames = (await listUsernames()).map((u) => u.value);
    const emails = await connectedEmails();
    const [uChecked, eChecked] = await Promise.all([lastChecked("username", usernames), lastChecked("email", emails)]);
    const recent = (m: Map<string, Date>, id: string) => {
      const at = m.get(id);
      return at !== undefined && now.getTime() - at.getTime() < COOLDOWN_MS;
    };
    const dueUsernames = usernames.filter((u) => !recent(uChecked, u));
    const dueEmails = emails.filter((e) => !recent(eChecked, e));
    const skippedRecent = usernames.length - dueUsernames.length + (emails.length - dueEmails.length);

    const sites = loadSites();
    const tasks: Task[] = [];
    for (const username of dueUsernames) {
      for (const site of sites.filter((s) => appliesTo(s, username))) {
        tasks.push(async () => {
          const r = await checkSite(site, username, deps.transport);
          await saveSiteResult(username, site.id, openUrl(site, username), r, now);
          return r.status === "found" ? "found" : r.status === "error" ? "error" : "other";
        });
      }
    }
    for (const email of dueEmails) {
      tasks.push(async () => {
        const r = await checkGravatar(email, deps.transport);
        await saveGravatarResult(email, r, now);
        return r.status === "found" ? "found" : r.status === "error" ? "error" : "other";
      });
    }

    if (tasks.length === 0) {
      g.__ghostHubProfileJob = undefined;
      return { started: false, reason: skippedRecent > 0 ? "recent" : "nothing", skippedRecent };
    }
    job.total = tasks.length;

    void (async () => {
      let next = 0;
      const worker = async () => {
        while (next < tasks.length && !job.controller.signal.aborted) {
          const task = tasks[next++];
          try {
            const outcome = await task();
            if (outcome === "found") job.found++;
            if (outcome === "error") job.errors++;
          } catch {
            job.errors++; // a storage failure for one result shouldn't stop the rest
          }
          job.done++;
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      job.running = false;
      job.finishedAt = Date.now();
    })();

    return { started: true, total: tasks.length, skippedRecent };
  } catch (err) {
    g.__ghostHubProfileJob = undefined;
    throw err;
  }
}
