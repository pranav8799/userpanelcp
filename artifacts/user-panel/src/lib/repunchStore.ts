// src/lib/repunchStore.ts
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react"; // Make sure this is imported
import {
  useGetSettings,
  useUpdateSettings,
  getGetSettingsQueryKey,
  type WatchedSlot as ApiWatchedSlot, // ← Import from API
  type OrderInputSide,
} from "@workspace/api-client-react";

// Extend the generated type with UI-specific fields
export interface WatchedSlot extends ApiWatchedSlot {
  stopped?: boolean;
  seenOpen?: boolean;
  tpOrderId?: string;
  tpSeenOpen?: boolean;
  repunchCount: number; // ensure this exists
}

// Local store for auto-punch toggle
let autoPunchEnabled = false;
const listeners = new Set<() => void>();

export const repunchStore = {
  getEnabled: () => autoPunchEnabled,
  setEnabled: (v: boolean) => {
    autoPunchEnabled = v;
    listeners.forEach((l) => l());
  },
  subscribe: (cb: () => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

export function useAutoPunchEnabled() {
  return useSyncExternalStore(repunchStore.subscribe, repunchStore.getEnabled);
}

export function useWatchedSlots(): WatchedSlot[] {
  const { data } = useGetSettings({
    query: { queryKey: getGetSettingsQueryKey(), refetchInterval: 5_000 },
  });
  return (data?.watchedSlots ?? []) as WatchedSlot[];
}

export function useSetWatchedSlots() {
  const queryClient = useQueryClient();
  const updateSettingsMut = useUpdateSettings();

  return useCallback(
    (updater: WatchedSlot[] | ((prev: WatchedSlot[]) => WatchedSlot[])) => {
      const currentData = queryClient.getQueryData<any>(getGetSettingsQueryKey());
      const prev = (currentData?.watchedSlots ?? []) as WatchedSlot[];

      const next = typeof updater === "function"
        ? (updater as (prev: WatchedSlot[]) => WatchedSlot[])(prev)
        : updater;

      updateSettingsMut.mutate(
        { data: { watchedSlots: next } },
        {
          onSuccess: () => {
            queryClient.setQueryData(getGetSettingsQueryKey(), (old: any) => ({
              ...old,
              watchedSlots: next,
            }));
            queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
          },
          onError: (err: any) => {
            console.error("Failed to persist watched slots", err);
          },
        }
      );
    },
    [queryClient, updateSettingsMut]
  );
}