'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import * as api from '@/lib/api';

// status: 'loading' (asking the backend), 'error' (the backend couldn't say; `error`
// holds why), 'anonymous' (show the login screen), 'guest' (full app, nothing saved), or
// 'user' (logged in).
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [auth, setAuth] = useState({ status: 'loading', user: null });
  // Bumped by "Try again" to ask the backend once more.
  const [check, setCheck] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.getMe().then(
      (user) => {
        if (!cancelled) setAuth(user ? { status: 'user', user } : { status: 'anonymous', user: null });
      },
      // getMe answers null when nobody is logged in, so this is the network or the server
      // failing. The user may well be logged in, so they aren't sent to the login screen.
      (error) => {
        if (!cancelled) setAuth({ status: 'error', user: null, error });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [check]);

  useEffect(() => {
    // A data request that finds the session gone (e.g. the session was removed on the
    // server) brings back the login screen.
    api.setLoggedOutHandler(() => setAuth({ status: 'anonymous', user: null }));
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
    // Throws when the backend can't be reached: the user stays logged in, and the caller
    // says so, so nobody leaves a device thinking they logged out.
    async logOut() {
      await api.logout();
      switchTo({ status: 'anonymous', user: null });
    },
    retry() {
      setAuth({ status: 'loading', user: null });
      setCheck((n) => n + 1);
    },
    async updateAccount(changes) {
      const user = await api.updateAccount(changes);
      setAuth({ status: 'user', user });
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
