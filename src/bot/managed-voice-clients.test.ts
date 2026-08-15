import { describe, expect, it } from "vitest";
import {
  ManagedVoiceClientRegistry,
  normalizeManagedVoiceClientScope,
  normalizeManagedVoiceHost,
} from "./managed-voice-clients.js";

describe("managed voice client scope normalization", () => {
  it("normalizes DNS host casing, whitespace, and trailing root dots", () => {
    expect(normalizeManagedVoiceHost("  Voice.Example.COM...  ")).toBe(
      "voice.example.com",
    );
    expect(
      normalizeManagedVoiceClientScope({
        host: "VOICE.EXAMPLE.COM.",
        voicePort: 9987,
      }),
    ).toEqual({ host: "voice.example.com", voicePort: 9987 });
  });

  it("treats bracketed and equivalent expanded IPv6 literals as one host", () => {
    expect(normalizeManagedVoiceHost("[2001:0DB8:0:0:0:0:0:1]")).toBe(
      "2001:db8::1",
    );
    expect(normalizeManagedVoiceHost("2001:db8::1")).toBe("2001:db8::1");
  });

  it("rejects empty hosts and invalid voice ports", () => {
    expect(
      normalizeManagedVoiceClientScope({ host: " . ", voicePort: 9987 }),
    ).toBeNull();
    expect(
      normalizeManagedVoiceClientScope({ host: "example.com", voicePort: 0 }),
    ).toBeNull();
    expect(
      normalizeManagedVoiceClientScope({
        host: "example.com",
        voicePort: 65_536,
      }),
    ).toBeNull();
  });

});

describe("ManagedVoiceClientRegistry", () => {
  it("finds clients through normalized forms of the same scope", () => {
    const registry = new ManagedVoiceClientRegistry();
    const owner = Symbol("connection");

    expect(
      registry.register(
        { host: " Voice.Example.COM. ", voicePort: 9987 },
        42,
        owner,
      ),
    ).toBe(true);
    expect(
      registry.has({ host: "voice.example.com", voicePort: 9987 }, 42),
    ).toBe(true);
  });

  it("keeps different voice ports and hosts in separate scopes", () => {
    const registry = new ManagedVoiceClientRegistry();
    registry.register(
      { host: "voice.example.com", voicePort: 9987 },
      7,
      Symbol("connection"),
    );

    expect(
      registry.has({ host: "voice.example.com", voicePort: 9988 }, 7),
    ).toBe(false);
    expect(
      registry.has({ host: "other.example.com", voicePort: 9987 }, 7),
    ).toBe(false);
  });

  it("finds a managed bot by stable client UID across network endpoints", () => {
    const registry = new ManagedVoiceClientRegistry();
    const owner = Symbol("connection");

    registry.register(
      { host: "127.0.0.1", voicePort: 9987 },
      17,
      owner,
      "  managed-client-uid=  ",
    );

    expect(registry.hasClientUid("managed-client-uid=")).toBe(true);
    expect(
      registry.has({ host: "192.168.1.10", voicePort: 20_000 }, 17),
    ).toBe(false);
  });

  it("keeps a shared managed UID until its last owner unregisters", () => {
    const registry = new ManagedVoiceClientRegistry();
    const scope = { host: "203.0.113.4", voicePort: 9987 };
    const first = Symbol("first connection");
    const second = Symbol("second connection");
    registry.register(scope, 18, first, "shared-client-uid=");
    registry.register(scope, 19, second, "shared-client-uid=");

    expect(registry.unregister(scope, 18, first, "shared-client-uid=")).toBe(true);
    expect(registry.hasClientUid("shared-client-uid=")).toBe(true);
    expect(registry.unregister(scope, 19, second, "shared-client-uid=")).toBe(true);
    expect(registry.hasClientUid("shared-client-uid=")).toBe(false);
  });

  it("ignores missing or empty client UIDs", () => {
    const registry = new ManagedVoiceClientRegistry();
    registry.register(
      { host: "203.0.113.4", voicePort: 9987 },
      19,
      Symbol("connection"),
      "   ",
    );

    expect(registry.hasClientUid(undefined)).toBe(false);
    expect(registry.hasClientUid("   ")).toBe(false);
  });

  it("uses an IPv6-safe scope key", () => {
    const registry = new ManagedVoiceClientRegistry();
    registry.register(
      { host: "[2001:0db8:0:0:0:0:0:1]", voicePort: 9987 },
      9,
      Symbol("connection"),
    );

    expect(
      registry.has({ host: "2001:db8::1", voicePort: 9987 }, 9),
    ).toBe(true);
  });

  it("does not let a delayed old disconnect remove a replacement", () => {
    const registry = new ManagedVoiceClientRegistry();
    const scope = { host: "voice.example.com", voicePort: 9987 };
    const oldConnection = Symbol("old connection");
    const newConnection = Symbol("new connection");

    registry.register(scope, 12, oldConnection, "managed-client-uid=");
    registry.register(scope, 12, newConnection, "managed-client-uid=");

    // The old UID owner is removed, but the replacement still owns both the
    // scoped id and the shared stable UID.
    expect(
      registry.unregister(scope, 12, oldConnection, "managed-client-uid="),
    ).toBe(true);
    expect(registry.has(scope, 12)).toBe(true);
    expect(registry.hasClientUid("managed-client-uid=")).toBe(true);
    expect(
      registry.unregister(scope, 12, newConnection, "managed-client-uid="),
    ).toBe(true);
    expect(registry.has(scope, 12)).toBe(false);
    expect(registry.hasClientUid("managed-client-uid=")).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "ignores invalid client id %s",
    (clientId) => {
      const registry = new ManagedVoiceClientRegistry();
      const scope = { host: "voice.example.com", voicePort: 9987 };
      const owner = Symbol("connection");

      expect(registry.register(scope, clientId, owner)).toBe(false);
      expect(registry.has(scope, clientId)).toBe(false);
      expect(registry.unregister(scope, clientId, owner)).toBe(false);
    },
  );

  it("has no shared module-level state between registry instances", () => {
    const first = new ManagedVoiceClientRegistry();
    const second = new ManagedVoiceClientRegistry();
    const scope = { host: "voice.example.com", voicePort: 9987 };

    first.register(scope, 3, Symbol("connection"));

    expect(first.has(scope, 3)).toBe(true);
    expect(second.has(scope, 3)).toBe(false);
  });

  describe("managed client kinds", () => {
    const scope = { host: "voice.example.com", voicePort: 9987 };

    it("treats a registered bot as a music client until its kind is flipped", () => {
      const registry = new ManagedVoiceClientRegistry();
      const owner = Symbol("connection");
      registry.register(scope, 30, owner, "bot-uid=");

      expect(registry.isManagedMusicClient(scope, 30, "bot-uid=")).toBe(true);
      expect(registry.isManagedMusicClient(scope, 30, undefined)).toBe(true);

      expect(registry.setKind(scope, 30, owner, "voice-bridge")).toBe(true);
      expect(registry.isManagedMusicClient(scope, 30, "bot-uid=")).toBe(false);
      // The UID path and the scoped client-id fallback agree.
      expect(registry.isManagedMusicClient(scope, 30, undefined)).toBe(false);
    });

    it("supports registering directly as a voice bridge", () => {
      const registry = new ManagedVoiceClientRegistry();
      registry.register(scope, 31, Symbol("connection"), "bridge-uid=", "voice-bridge");

      expect(registry.isManagedMusicClient(scope, 31, "bridge-uid=")).toBe(false);
    });

    it("leaves unmanaged senders (native humans) unclassified", () => {
      const registry = new ManagedVoiceClientRegistry();

      expect(registry.isManagedMusicClient(scope, 99, "human-uid=")).toBe(false);
    });

    it("rejects kind changes from an owner that no longer owns the id", () => {
      const registry = new ManagedVoiceClientRegistry();
      const owner = Symbol("old connection");
      registry.register(scope, 32, owner, "bot-uid=");
      registry.register(scope, 32, Symbol("new connection"), "bot-uid=");

      expect(registry.setKind(scope, 32, owner, "voice-bridge")).toBe(false);
      expect(registry.isManagedMusicClient(scope, 32, "bot-uid=")).toBe(true);
    });

    it("forgets the kind when the owner unregisters", () => {
      const registry = new ManagedVoiceClientRegistry();
      const owner = Symbol("connection");
      registry.register(scope, 33, owner, "bot-uid=");
      registry.setKind(scope, 33, owner, "voice-bridge");
      registry.unregister(scope, 33, owner, "bot-uid=");

      // Re-registering the same id fresh starts as music again.
      const next = Symbol("reconnect");
      registry.register(scope, 33, next, "bot-uid=");
      expect(registry.isManagedMusicClient(scope, 33, "bot-uid=")).toBe(true);
    });
  });
});
