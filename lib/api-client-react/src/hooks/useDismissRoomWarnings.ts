import { useMutation, type UseMutationOptions, type UseMutationResult } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

export type DismissRoomWarningsBody = { roomIds: string[] };
export type DismissRoomWarnings200 = { updated: number };

export const dismissRoomWarnings = async (
  jobId: string,
  body: DismissRoomWarningsBody,
  options?: RequestInit,
): Promise<DismissRoomWarnings200> => {
  return customFetch<DismissRoomWarnings200>(`/api/jobs/${jobId}/rooms/dismiss-warnings`, {
    ...options,
    method: "POST",
    headers: { "Content-Type": "application/json", ...options?.headers },
    body: JSON.stringify(body),
  });
};

export const useDismissRoomWarnings = <
  TError = unknown,
  TContext = unknown,
>(options?: {
  mutation?: UseMutationOptions<
    DismissRoomWarnings200,
    TError,
    { jobId: string; data: DismissRoomWarningsBody },
    TContext
  >;
}): UseMutationResult<
  DismissRoomWarnings200,
  TError,
  { jobId: string; data: DismissRoomWarningsBody },
  TContext
> => {
  return useMutation({
    mutationKey: ["dismissRoomWarnings"],
    mutationFn: ({ jobId, data }) => dismissRoomWarnings(jobId, data),
    ...options?.mutation,
  });
};
