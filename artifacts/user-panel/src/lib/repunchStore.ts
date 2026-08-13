// src/lib/repunchStore.ts
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import {
  useGetSettings,
  useUpdateSettings,
  getGetSettingsQueryKey,
  type WatchedSlot as ApiWatchedSlot,
  type OrderInputSide,
} from "@workspace/api-client-react";

export interface WatchedSlot extends ApiWatchedSlot {
  stopped?: boolean;
  seenOpen?: boolean;
  tpOrderId?: string;
  tpSeenOpen?: boolean;
  repunchCount: number;
  batchId?: string;
  stepSize?: number;
  doubleQtyEnabled?: boolean;
  baseQty?: number;
  totalLegs?: number;
  // Multiplier (1–5) applied to stepSize to decide how far the market is
  // allowed to run away from the topmost tracked leg — while NOTHING in
  // this batch is currently an open position — before the whole ladder is
  // scrapped and rebuilt starting from (marketPrice ∓ stepSize*stepSizeIncrement).
  // Stamped once at creation, same as stepSize, and shared across the batch.
  stepSizeIncrement?: number;
}

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



// 10/08/2026*****************************************************************************************************











// // src/lib/repunchStore.ts
// import { useCallback } from "react";
// import { useQueryClient } from "@tanstack/react-query";
// import { useSyncExternalStore } from "react"; // Make sure this is imported
// import {
//   useGetSettings,
//   useUpdateSettings,
//   getGetSettingsQueryKey,
//   type WatchedSlot as ApiWatchedSlot, // ← Import from API
//   type OrderInputSide,
// } from "@workspace/api-client-react";

// // Extend the generated type with UI-specific fields.
// // `status` is widened to include "queued" — a ladder leg waiting in line
// // for a slot to open up in the concurrency window (see place-order.tsx /
// // repunchEngine.ts). The API type doesn't know about "queued" since it's
// // resolved into "pending_fill" before ever being persisted... except it IS
// // persisted (queued slots sit in watchedSlots until activated), so we widen
// // here rather than assume the generated type covers it.
// export interface WatchedSlot extends ApiWatchedSlot {
//   stopped?: boolean;
//   seenOpen?: boolean;
//   tpOrderId?: string;
//   tpSeenOpen?: boolean;
//   repunchCount: number; // ensure this exists
//   batchId?: string; // groups ladder legs placed together, so the engine knows which "queued" leg (pending_fill + no orderId) to activate next
// }
// let autoPunchEnabled = false;
// const listeners = new Set<() => void>();

// export const repunchStore = {
//   getEnabled: () => autoPunchEnabled,
//   setEnabled: (v: boolean) => {
//     autoPunchEnabled = v;
//     listeners.forEach((l) => l());
//   },
//   subscribe: (cb: () => void) => {
//     listeners.add(cb);
//     return () => listeners.delete(cb);
//   },
// };

// export function useAutoPunchEnabled() {
//   return useSyncExternalStore(repunchStore.subscribe, repunchStore.getEnabled);
// }

// export function useWatchedSlots(): WatchedSlot[] {
//   const { data } = useGetSettings({
//     query: { queryKey: getGetSettingsQueryKey(), refetchInterval: 5_000 },
//   });
//   return (data?.watchedSlots ?? []) as WatchedSlot[];
// }

// export function useSetWatchedSlots() {
//   const queryClient = useQueryClient();
//   const updateSettingsMut = useUpdateSettings();

//   return useCallback(
//     (updater: WatchedSlot[] | ((prev: WatchedSlot[]) => WatchedSlot[])) => {
//       const currentData = queryClient.getQueryData<any>(getGetSettingsQueryKey());
//       const prev = (currentData?.watchedSlots ?? []) as WatchedSlot[];

//       const next = typeof updater === "function"
//         ? (updater as (prev: WatchedSlot[]) => WatchedSlot[])(prev)
//         : updater;

//       updateSettingsMut.mutate(
//         { data: { watchedSlots: next } },
//         {
//           onSuccess: () => {
//             queryClient.setQueryData(getGetSettingsQueryKey(), (old: any) => ({
//               ...old,
//               watchedSlots: next,
//             }));
//             queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
//           },
//           onError: (err: any) => {
//             console.error("Failed to persist watched slots", err);
//           },
//         }
//       );
//     },
//     [queryClient, updateSettingsMut]
//   );
// }









// // src/lib/repunchStore.ts
// import { useCallback } from "react";
// import { useQueryClient } from "@tanstack/react-query";
// import { useSyncExternalStore } from "react"; // Make sure this is imported
// import {
//   useGetSettings,
//   useUpdateSettings,
//   getGetSettingsQueryKey,
//   type WatchedSlot as ApiWatchedSlot, // ← Import from API
//   type OrderInputSide,
// } from "@workspace/api-client-react";

// // Extend the generated type with UI-specific fields
// export interface WatchedSlot extends ApiWatchedSlot {
//   stopped?: boolean;
//   seenOpen?: boolean;
//   tpOrderId?: string;
//   tpSeenOpen?: boolean;
//   repunchCount: number; // ensure this exists
// }

// // Local store for auto-punch toggle
// let autoPunchEnabled = false;
// const listeners = new Set<() => void>();

// export const repunchStore = {
//   getEnabled: () => autoPunchEnabled,
//   setEnabled: (v: boolean) => {
//     autoPunchEnabled = v;
//     listeners.forEach((l) => l());
//   },
//   subscribe: (cb: () => void) => {
//     listeners.add(cb);
//     return () => listeners.delete(cb);
//   },
// };

// export function useAutoPunchEnabled() {
//   return useSyncExternalStore(repunchStore.subscribe, repunchStore.getEnabled);
// }

// export function useWatchedSlots(): WatchedSlot[] {
//   const { data } = useGetSettings({
//     query: { queryKey: getGetSettingsQueryKey(), refetchInterval: 5_000 },
//   });
//   return (data?.watchedSlots ?? []) as WatchedSlot[];
// }

// export function useSetWatchedSlots() {
//   const queryClient = useQueryClient();
//   const updateSettingsMut = useUpdateSettings();

//   return useCallback(
//     (updater: WatchedSlot[] | ((prev: WatchedSlot[]) => WatchedSlot[])) => {
//       const currentData = queryClient.getQueryData<any>(getGetSettingsQueryKey());
//       const prev = (currentData?.watchedSlots ?? []) as WatchedSlot[];

//       const next = typeof updater === "function"
//         ? (updater as (prev: WatchedSlot[]) => WatchedSlot[])(prev)
//         : updater;

//       updateSettingsMut.mutate(
//         { data: { watchedSlots: next } },
//         {
//           onSuccess: () => {
//             queryClient.setQueryData(getGetSettingsQueryKey(), (old: any) => ({
//               ...old,
//               watchedSlots: next,
//             }));
//             queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
//           },
//           onError: (err: any) => {
//             console.error("Failed to persist watched slots", err);
//           },
//         }
//       );
//     },
//     [queryClient, updateSettingsMut]
//   );
// }