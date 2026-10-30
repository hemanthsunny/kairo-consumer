import type { Session } from "@supabase/supabase-js";
import { createContext, ReactNode, useContext, useEffect, useState } from "react";
import { supabase } from "./supabase";

interface AuthState {
  session: Session | null;
  ready: boolean;
}

const Ctx = createContext<AuthState>({ session: null, ready: false });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ session: null, ready: false });
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setState({ session: data.session, ready: true }));
    const { data } = supabase.auth.onAuthStateChange((_e, session) => setState({ session, ready: true }));
    return () => data.subscription.unsubscribe();
  }, []);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
