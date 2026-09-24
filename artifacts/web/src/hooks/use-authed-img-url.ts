import { useState, useEffect } from "react";
import { useAuthFetch } from "./use-auth-fetch";
import { useGuestAuth } from "@/contexts/GuestAuthContext";

interface AuthedImgUrl {
  displayUrl: string | null;
  fetching: boolean;
  fetchFailed: boolean;
}

/**
 * For Clerk-authenticated users the session cookie is sent automatically by
 * the browser, so `<img src>` works without extra headers and we return the
 * API URL unchanged.
 *
 * For guest sessions the browser cannot attach the Bearer token to image
 * requests, so we fetch the image data through the auth-aware fetch wrapper
 * and return a blob URL instead.
 */
export function useAuthedImgUrl(apiUrl: string | null): AuthedImgUrl {
  const { guestSession } = useGuestAuth();
  const authFetch = useAuthFetch();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchFailed, setFetchFailed] = useState(false);

  const isGuest = Boolean(guestSession?.token);

  useEffect(() => {
    if (!isGuest) {
      setBlobUrl(null);
      setFetching(false);
      setFetchFailed(false);
      return;
    }
    if (!apiUrl) {
      setBlobUrl(null);
      setFetching(false);
      setFetchFailed(false);
      return;
    }

    let cancelled = false;
    let objectUrl: string | null = null;

    setFetching(true);
    setBlobUrl(null);
    setFetchFailed(false);

    authFetch(apiUrl)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
        setFetching(false);
      })
      .catch(() => {
        if (!cancelled) {
          setBlobUrl(null);
          setFetching(false);
          setFetchFailed(true);
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [apiUrl, isGuest, authFetch]);

  if (!isGuest) {
    return { displayUrl: apiUrl, fetching: false, fetchFailed: false };
  }
  return { displayUrl: blobUrl, fetching, fetchFailed };
}
