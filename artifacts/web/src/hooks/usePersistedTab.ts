import { useState, useEffect } from "react";

export function usePersistedTab(
  key: string,
  validTabs: string[],
  defaultTab: string,
  queryParam?: string
) {
  const [activeTab, setActiveTab] = useState(() => {
    if (queryParam) {
      try {
        const params = new URLSearchParams(window.location.search);
        const urlTab = params.get(queryParam);
        if (urlTab && validTabs.includes(urlTab)) return urlTab;
      } catch {
        // ignore
      }
    }
    try {
      const stored = localStorage.getItem(key);
      return stored && validTabs.includes(stored) ? stored : defaultTab;
    } catch {
      return defaultTab;
    }
  });

  useEffect(() => {
    if (!queryParam) return;

    const handlePopState = () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const urlTab = params.get(queryParam);
        if (urlTab && validTabs.includes(urlTab)) {
          setActiveTab(urlTab);
          try {
            localStorage.setItem(key, urlTab);
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [key, queryParam, validTabs]);

  const handleTabChange = (tab: string) => {
    try {
      localStorage.setItem(key, tab);
    } catch {
      // ignore storage errors
    }
    if (queryParam) {
      try {
        const params = new URLSearchParams(window.location.search);
        params.set(queryParam, tab);
        const newUrl =
          window.location.pathname + "?" + params.toString() + window.location.hash;
        history.replaceState(null, "", newUrl);
      } catch {
        // ignore
      }
    }
    setActiveTab(tab);
  };

  return [activeTab, handleTabChange] as const;
}
