import { useMutation, type UseMutationOptions, type UseMutationResult } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

export type InvalidateSnapshotsCacheResponse = { invalidated: boolean };

export const invalidateSnapshotsCache = async (
  options?: RequestInit,
): Promise<InvalidateSnapshotsCacheResponse> => {
  return customFetch<InvalidateSnapshotsCacheResponse>("/api/training/snapshots/cache/invalidate", {
    ...options,
    method: "POST",
  });
};

export const useInvalidateSnapshotsCache = <
  TError = unknown,
  TContext = unknown,
>(options?: {
  mutation?: UseMutationOptions<
    InvalidateSnapshotsCacheResponse,
    TError,
    void,
    TContext
  >;
}): UseMutationResult<
  InvalidateSnapshotsCacheResponse,
  TError,
  void,
  TContext
> => {
  return useMutation({
    mutationKey: ["invalidateSnapshotsCache"],
    mutationFn: () => invalidateSnapshotsCache(),
    ...options?.mutation,
  });
};
