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

// Extend the generated type with UI-specific fields.
// `status` is widened to include "queued" — a ladder leg waiting in line
// for a slot to open up in the concurrency window (see place-order.tsx /
// repunchEngine.ts). The API type doesn't know about "queued" since it's
// resolved into "pending_fill" before ever being persisted... except it IS
// persisted (queued slots sit in watchedSlots until activated), so we widen
// here rather than assume the generated type covers it.
export interface WatchedSlot extends ApiWatchedSlot {
  stopped?: boolean;
  seenOpen?: boolean;
  tpOrderId?: string;
  tpSeenOpen?: boolean;
  repunchCount: number; // ensure this exists
  batchId?: string; // groups ladder legs placed together, so the engine knows which "queued" leg (pending_fill + no orderId) to activate next
  // The ladder's buy-diff (step size) in points, copied onto every slot at
  // creation (entry + ladder legs, live or queued). Needed by the repunch
  // engine's Phase 2 shift step to know how far past the triggering leg's
  // price to place the new leg — the engine has no other source of truth
  // for this once a slot exists.
  stepSize?: number;
  // Per-trade toggle: when true, the farther half of the batch (by rank —
  // see totalLegs) trades at 2× baseQty instead of baseQty. Off by default.
  // Stamped once at creation and shared across every leg in the batch.
  doubleQtyEnabled?: boolean;
  // The unit qty entered on the ticket — never changes. `quantity` on this
  // slot holds whatever qty was actually used for this leg's most recent
  // live placement (baseQty or baseQty*2); baseQty is kept separately so
  // the engine can always recompute the doubled amount later.
  baseQty?: number;
  // Fixed leg count for this batch's whole lifetime (numberOfOrders + 1).
  // The base/double split point (ceil(totalLegs/2)) is derived from this,
  // not from the batch's current array length, since array length can
  // temporarily drift during the trim-skipped-because-watching edge case.
  totalLegs?: number;
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