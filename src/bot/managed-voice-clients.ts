import { isIP } from "node:net";

/** Identifies one TeamSpeak voice server. */
export interface ManagedVoiceClientScope {
  host: string;
  voicePort: number;
}

export interface NormalizedManagedVoiceClientScope {
  readonly host: string;
  readonly voicePort: number;
}

/**
 * An opaque value identifying the connection that owns a client id.
 *
 * A fresh object or Symbol per connection is recommended. Value tokens are
 * also supported for callers that already have a unique connection id.
 */
export type ManagedVoiceClientOwnerToken = object | string | number | symbol;

/**
 * What a managed connection is for. "music" bots play local/streamed audio —
 * their packets must never duck other bots. "voice-bridge" bots relay a live
 * human microphone (web voice callers), so their packets ARE human speech and
 * should trigger ducking on music bots exactly like a native client would.
 */
export type ManagedVoiceClientKind = "music" | "voice-bridge";

/**
 * Normalize a TeamSpeak host for comparisons.
 *
 * DNS names are case-insensitive and may include a trailing root dot. IPv6
 * literals may be supplied either bare or in URL-style brackets; valid IPv6
 * addresses are also put into the canonical form produced by the URL parser.
 */
export function normalizeManagedVoiceHost(host: string): string {
  let normalized = host.trim().toLowerCase().replace(/\.+$/, "");

  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }

  if (isIP(normalized) === 6) {
    // URL's host serializer compresses equivalent IPv6 spellings. `isIP`
    // ensures interpolation cannot be interpreted as another URL component.
    const serialized = new URL(`http://[${normalized}]/`).hostname;
    return serialized.slice(1, -1);
  }

  return normalized;
}

/** Return a comparable scope, or null when the runtime input is unusable. */
export function normalizeManagedVoiceClientScope(
  scope: ManagedVoiceClientScope,
): NormalizedManagedVoiceClientScope | null {
  if (
    !scope ||
    typeof scope.host !== "string" ||
    typeof scope.voicePort !== "number"
  ) {
    return null;
  }

  const host = normalizeManagedVoiceHost(scope.host);
  if (
    host.length === 0 ||
    !Number.isInteger(scope.voicePort) ||
    scope.voicePort < 1 ||
    scope.voicePort > 65_535
  ) {
    return null;
  }

  return { host, voicePort: scope.voicePort };
}

function scopeKey(scope: ManagedVoiceClientScope): string | null {
  const normalized = normalizeManagedVoiceClientScope(scope);
  if (!normalized) return null;

  // A serialized tuple stays unambiguous when host itself contains colons.
  return JSON.stringify([normalized.host, normalized.voicePort]);
}

function validClientId(clientId: number): boolean {
  return Number.isSafeInteger(clientId) && clientId > 0;
}

function normalizeClientUid(clientUid: string | undefined): string | null {
  if (typeof clientUid !== "string") return null;
  const normalized = clientUid.trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Tracks voice client ids and stable TeamSpeak identities owned by bot
 * connections in this process. The UID path survives DNS aliases, NAT,
 * multiple NICs, and dual-stack endpoints; scoped ids remain a fallback when
 * a sender has not yet appeared in the receiving client's view cache.
 *
 * This class intentionally has no module-level singleton. BotManager owns one
 * instance and injects it into its BotInstances so separate managers remain
 * isolated in tests and in the same process.
 */
export class ManagedVoiceClientRegistry {
  private readonly clientsByScope = new Map<
    string,
    Map<number, ManagedVoiceClientOwnerToken>
  >();
  private readonly ownersByClientUid = new Map<
    string,
    Set<ManagedVoiceClientOwnerToken>
  >();
  private readonly kindsByOwner = new Map<ManagedVoiceClientOwnerToken, ManagedVoiceClientKind>();

  /**
   * Register (or replace) the connection that owns a client id and, when
   * available, add its stable UID to the managed set. The kind defaults to
   * "music" and can be flipped later via setKind (e.g. when a web voice
   * listener attaches to a bot and it starts relaying a human microphone).
   * Returns false when the scope or client id is invalid.
   */
  register(
    scope: ManagedVoiceClientScope,
    clientId: number,
    ownerToken: ManagedVoiceClientOwnerToken,
    clientUid?: string,
    kind: ManagedVoiceClientKind = "music",
  ): boolean {
    const key = scopeKey(scope);
    if (!key || !validClientId(clientId)) return false;

    let clients = this.clientsByScope.get(key);
    if (!clients) {
      clients = new Map();
      this.clientsByScope.set(key, clients);
    }
    clients.set(clientId, ownerToken);
    this.kindsByOwner.set(ownerToken, kind);

    const normalizedUid = normalizeClientUid(clientUid);
    if (normalizedUid) {
      let owners = this.ownersByClientUid.get(normalizedUid);
      if (!owners) {
        owners = new Set();
        this.ownersByClientUid.set(normalizedUid, owners);
      }
      owners.add(ownerToken);
    }
    return true;
  }

  /**
   * Flip the kind of a still-registered connection (ownership-checked, like
   * unregister). Returns false when this connection no longer owns the id.
   */
  setKind(
    scope: ManagedVoiceClientScope,
    clientId: number,
    ownerToken: ManagedVoiceClientOwnerToken,
    kind: ManagedVoiceClientKind,
  ): boolean {
    const key = scopeKey(scope);
    if (!key || !validClientId(clientId)) return false;
    if (this.clientsByScope.get(key)?.get(clientId) !== ownerToken) return false;
    this.kindsByOwner.set(ownerToken, kind);
    return true;
  }

  /**
   * Remove a client only if it is still owned by this connection.
   *
   * The ownership check prevents a delayed disconnect from an old connection
   * deleting a newer connection that reused the same TeamSpeak client id.
   */
  unregister(
    scope: ManagedVoiceClientScope,
    clientId: number,
    ownerToken: ManagedVoiceClientOwnerToken,
    clientUid?: string,
  ): boolean {
    const key = scopeKey(scope);
    if (!key || !validClientId(clientId)) return false;

    let removed = false;
    const clients = this.clientsByScope.get(key);
    if (clients?.get(clientId) === ownerToken) {
      clients.delete(clientId);
      if (clients.size === 0) this.clientsByScope.delete(key);
      removed = true;
    }

    const normalizedUid = normalizeClientUid(clientUid);
    if (normalizedUid) {
      const owners = this.ownersByClientUid.get(normalizedUid);
      if (owners?.delete(ownerToken)) removed = true;
      if (owners?.size === 0) this.ownersByClientUid.delete(normalizedUid);
    }
    if (removed) this.kindsByOwner.delete(ownerToken);
    return removed;
  }

  has(scope: ManagedVoiceClientScope, clientId: number): boolean {
    const key = scopeKey(scope);
    if (!key || !validClientId(clientId)) return false;
    return this.clientsByScope.get(key)?.has(clientId) ?? false;
  }

  /** TeamSpeak client UIDs are stable across endpoint aliases and NAT paths. */
  hasClientUid(clientUid: string | undefined): boolean {
    const normalizedUid = normalizeClientUid(clientUid);
    return normalizedUid
      ? (this.ownersByClientUid.get(normalizedUid)?.size ?? 0) > 0
      : false;
  }

  /**
   * True when the sender is a managed connection whose packets are local
   * playback (a "music" bot) rather than a relayed human microphone. Music
   * packets must not trigger ducking on other bots; voice-bridge packets are
   * human speech and duck normally. Unknown/unmanaged senders (native human
   * clients) return false, so they duck normally too.
   */
  isManagedMusicClient(
    scope: ManagedVoiceClientScope,
    clientId: number,
    clientUid: string | undefined,
  ): boolean {
    const key = scopeKey(scope);
    const uidOwners = (() => {
      const normalizedUid = normalizeClientUid(clientUid);
      return normalizedUid ? this.ownersByClientUid.get(normalizedUid) : undefined;
    })();

    if (uidOwners && uidOwners.size > 0) {
      for (const owner of uidOwners) {
        if (this.kindsByOwner.get(owner) !== "voice-bridge") return true;
      }
      return false;
    }

    if (!key || !validClientId(clientId)) return false;
    const owner = this.clientsByScope.get(key)?.get(clientId);
    if (owner === undefined) return false;
    return this.kindsByOwner.get(owner) !== "voice-bridge";
  }
}
