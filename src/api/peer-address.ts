/**
 * Transport-layer peer capture for Next.js route handlers.
 *
 * Next.js 15 route handlers receive a Web `Request`; the original Node socket is
 * not exposed on it. Forwarding headers are client-controlled, so the rate limiter
 * needs the actual TCP peer to decide whether a proxy is trusted.
 *
 * This module subscribes to Node's `http.server.request.start` diagnostics channel
 * and stores `socket.remoteAddress` in an AsyncLocalStorage scope that propagates
 * into the request handler. The value is never read from a header.
 *
 * The state is kept on `globalThis` so instrumentation and route handlers share the
 * same storage even if Next.js evaluates them in separate module contexts.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { subscribe } from "node:diagnostics_channel";

type PeerState = {
  storage: AsyncLocalStorage<string | null>;
  installed: boolean;
};

const globalScope = globalThis as typeof globalThis & {
  __khanthmanPeerAddressState__?: PeerState;
};

function peerState(): PeerState {
  if (!globalScope.__khanthmanPeerAddressState__) {
    globalScope.__khanthmanPeerAddressState__ = {
      storage: new AsyncLocalStorage<string | null>(),
      installed: false,
    };
  }
  return globalScope.__khanthmanPeerAddressState__;
}

/** Install the diagnostics-channel subscriber once per process. */
export function installPeerAddressCapture(): void {
  const state = peerState();
  if (state.installed) return;
  state.installed = true;

  subscribe("http.server.request.start", (message) => {
    const socket = (message as { socket?: { remoteAddress?: string } }).socket;
    state.storage.enterWith(socket?.remoteAddress ?? null);
  });
}

/** Captured TCP peer for the current request, or null when unavailable. */
export function getPeerAddress(): string | null {
  return peerState().storage.getStore() ?? null;
}

/** Test/helper scope: run a function with an explicit captured peer. */
export function runWithPeerAddress<T>(peer: string | null, fn: () => T): T {
  return peerState().storage.run(peer, fn);
}
