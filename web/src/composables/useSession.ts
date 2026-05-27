import { ref, computed, readonly } from "vue";

interface User {
  id: string;
  username: string;
  role: 'admin' | 'member';
}

const currentUser = ref<User | null>(null);
const needsSetup = ref<boolean | null>(null); // null = unknown / not fetched yet
const ready = ref(false);

async function refreshNeedsSetup(): Promise<void> {
  const res = await fetch("/api/session/needs-setup", { credentials: "same-origin" });
  if (res.ok) {
    const body = await res.json();
    needsSetup.value = Boolean(body.needsSetup);
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
}

async function logout(): Promise<void> {
  await fetch("/api/session/logout", { method: "POST", credentials: "same-origin" });
  currentUser.value = null;
}

export function useSession() {
  return {
    currentUser: readonly(currentUser),
    needsSetup: readonly(needsSetup),
    isAuthenticated: computed(() => currentUser.value !== null),
    isAdmin: computed(() => currentUser.value?.role === 'admin'),
    ready: readonly(ready),
    refresh,
    login,
    logout,
    setup,
  };
}
