import { ref, computed, readonly } from "vue";

interface User {
  id: string;
  username: string;
  role: 'admin' | 'member' | 'guest';
  capabilities?: string[];
  bots?: "all" | string[];
  guest?: Record<string, boolean> | null;
}

const currentUser = ref<User | null>(null);
const needsSetup = ref<boolean | null>(null); // null = unknown / not fetched yet
const guestAllowed = ref(false);
const ready = ref(false);

let pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL_MS = 60_000;

function ensurePollStarted() {
  if (pollTimer !== null) return;
  pollTimer = setInterval(() => {
    if (currentUser.value !== null) {
      // Best-effort refresh; ignore errors (network blips etc.)
      refreshMe().catch(() => {});
    }
  }, POLL_INTERVAL_MS);
}

function stopPoll() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function refreshNeedsSetup(): Promise<void> {
  const res = await fetch("/api/session/needs-setup", { credentials: "same-origin" });
  if (res.ok) {
    const body = await res.json();
    needsSetup.value = Boolean(body.needsSetup);
    guestAllowed.value = Boolean(body.guestAllowed);
  }
}

async function refreshMe(): Promise<void> {
  const res = await fetch("/api/session/me", { credentials: "same-origin" });
  if (res.status === 200) {
    currentUser.value = (await res.json()) as User;
  } else {
    currentUser.value = null;
  }
}

async function refresh(): Promise<void> {
  await refreshNeedsSetup();
  if (needsSetup.value) {
    currentUser.value = null;
  } else {
    await refreshMe();
  }
  ready.value = true;
  ensurePollStarted();
}

async function login(username: string, password: string): Promise<void> {
  const res = await fetch("/api/session/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `login failed (${res.status})`);
  }
  currentUser.value = (await res.json()) as User;
  // Login response omits capabilities/bots; fetch the authoritative ones from /me.
  await refreshMe();
}

async function continueAsGuest(): Promise<void> {
  const res = await fetch("/api/session/guest", { method: "POST", credentials: "same-origin" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `guest entry failed (${res.status})`);
  }
  currentUser.value = (await res.json()) as User;
  await refreshMe(); // authoritative role + guest flags + bots
}

async function setup(username: string, password: string): Promise<void> {
  const res = await fetch("/api/session/setup", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `setup failed (${res.status})`);
  }
  currentUser.value = (await res.json()) as User;
  needsSetup.value = false;
  // Setup response omits capabilities/bots; fetch the authoritative ones from /me.
  await refreshMe();
}

async function logout(): Promise<void> {
  stopPoll();
  await fetch("/api/session/logout", { method: "POST", credentials: "same-origin" });
  currentUser.value = null;
}

function can(cap: string): boolean {
  const u = currentUser.value;
  return !!u && (u.role === "admin" || (u.capabilities ?? []).includes(cap));
}

function guestCan(flag: string): boolean {
  const u = currentUser.value;
  return !!u && u.role === "guest" && !!u.guest && u.guest[flag] === true;
}

function canControlBot(botId: string): boolean {
  const u = currentUser.value;
  if (!u) return false;
  if (u.role === "admin" || u.bots === "all") return true;
  return Array.isArray(u.bots) && u.bots.includes(botId);
}

export function useSession() {
  return {
    currentUser: readonly(currentUser),
    needsSetup: readonly(needsSetup),
    guestAllowed: readonly(guestAllowed),
    isAuthenticated: computed(() => currentUser.value !== null),
    isAdmin: computed(() => currentUser.value?.role === 'admin'),
    isGuest: computed(() => currentUser.value?.role === 'guest'),
    ready: readonly(ready),
    refresh,
    login,
    logout,
    setup,
    continueAsGuest,
    can,
    guestCan,
    canControlBot,
  };
}
