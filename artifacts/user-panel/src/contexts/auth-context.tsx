import React, { createContext, useContext, useEffect, useState } from "react";
import { useGetMe } from "@workspace/api-client-react";
import type { AccountInfo } from "@workspace/api-client-react/src/generated/api.schemas";
import { useLocation } from "wouter";

interface AuthContextType {
  account: AccountInfo | null;
  isLoading: boolean;
  clearAuth: () => void;
  setAccount: (account: AccountInfo) => void;
}

const AuthContext = createContext<AuthContextType>({
  account: null,
  isLoading: true,
  clearAuth: () => {},
  setAccount: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [location, setLocation] = useLocation();
  
  const { data, isLoading, error } = useGetMe({
    query: {
      retry: false,
    }
  });

  useEffect(() => {
    if (data && !error) {
      setAccount(data);
    } else if (error) {
      setAccount(null);
      if (location !== '/login') {
        setLocation('/login');
      }
    }
  }, [data, error, location, setLocation]);

  const clearAuth = () => {
    setAccount(null);
    setLocation('/login');
  };

  return (
    <AuthContext.Provider value={{ account, isLoading, clearAuth, setAccount }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
