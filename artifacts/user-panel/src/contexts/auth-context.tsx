import React, { createContext, useContext, useEffect, useState } from "react";
import { useGetMe, getGetMeQueryKey, type AccountInfo } from "@workspace/api-client-react";
import { useLocation } from "wouter";

interface AuthContextType {
  account: AccountInfo | null;
  isLoading: boolean;
  clearAuth: () => void;
  setAccount: (account: AccountInfo) => void;
  refetchMe: () => void;
}

const AuthContext = createContext<AuthContextType>({
  account: null,
  isLoading: true,
  clearAuth: () => {},
  setAccount: () => {},
  refetchMe: () => {},
});

const PUBLIC_ROUTES = ['/login', '/signup'];

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccountState] = useState<AccountInfo | null>(null);
  const [location, setLocation] = useLocation();

  const { data, isLoading, error, refetch } = useGetMe({
    query: { queryKey: getGetMeQueryKey(), retry: false },
  });

  useEffect(() => {
    if (data && !error) {
      setAccountState(data);
    } else if (error) {
      setAccountState(null);
    }
  }, [data, error]);

  useEffect(() => {
    if (!isLoading && !account && !PUBLIC_ROUTES.includes(location)) {
      setLocation('/login');
    }
  }, [isLoading, account, location, setLocation]);

  const setAccount = (acc: AccountInfo) => {
    setAccountState(acc);
    void refetch();
  };

  const clearAuth = () => {
    setAccountState(null);
    setLocation('/login');
  };

  return (
    <AuthContext.Provider value={{ account, isLoading, clearAuth, setAccount, refetchMe: refetch }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
