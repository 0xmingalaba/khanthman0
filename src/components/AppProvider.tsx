"use client";

/**
 * Session context.
 *
 * One place that knows who is signed in and what their wallet holds. Components
 * read from here instead of making their own auth requests, which keeps the
 * header, tickets and portfolio consistent after a mutation.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, type SessionUser, type Wallet } from "@/src/lib/api-client";

type AppState = {
  user: SessionUser | null;
  wallet: Wallet | null;
  ready: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  setWallet: (wallet: Wallet | null) => void;
};

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const session = await api.session();
      setUser(session.user);
      setWallet(session.wallet);
    } catch {
      setUser(null);
      setWallet(null);
    } finally {
      setReady(true);
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
      setWallet(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ user, wallet, ready, refresh, signOut, setWallet }),
    [user, wallet, ready, refresh, signOut]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppState {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used inside AppProvider");
  return context;
}
