'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import * as api from '@/lib/api';

// status: 'loading' (asking the backend), 'anonymous' (show the login screen),
// 'guest' (full app, nothing saved), or 'user' (logged in).
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [auth, setAuth] = useState({ status: 'loading', user: null });

  useEffect(() => {
    let cancelled = false;
    // If the backend can't be reached (e.g. the frontend dev server alone), the login
    // screen still offers the guest mode, so the app stays usable.
    api
      .getMe()
      .catch(() => null)
      .then((user) => {
        if (!cancelled) setAuth(user ? { status: 'user', user } : { status: 'anonymous', user: null });
      });
    // A data request that finds the session gone (e.g. the admin deleted this user)
    // brings back the login screen.
    api.setLoggedOutHandler(() => setAuth({ status: 'anonymous', user: null }));
    return () => {
      cancelled = true;
    };
  }, []);

  // A guest's data lives only in memory and a user's comes from the backend. Every change
  // of who uses the app also empties the guest store, so one guest's data never shows
  // for the next person.
  const switchTo = (next) => {
    api.setGuestMode(next.status === 'guest');
    setAuth(next);
  };

  const value = {
    ...auth,
    async logIn(username, password) {
      switchTo({ status: 'user', user: await api.login(username, password) });
    },
    async signUp(username, password) {
      switchTo({ status: 'user', user: await api.register(username, password) });
    },
    async logOut() {
      await api.logout();
      switchTo({ status: 'anonymous', user: null });
    },
    continueAsGuest() {
      switchTo({ status: 'guest', user: null });
    },
    // A guest who wants to log in goes back to the login screen.
    leaveGuest() {
      switchTo({ status: 'anonymous', user: null });
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
