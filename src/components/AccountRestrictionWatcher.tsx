"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import {
  RESTRICTED_PATH,
  RESTRICTION_STATUS_API_PATH,
} from "@/lib/account-restriction";

type RestrictionStatusResponse = {
  ok?: boolean;
  code?: string;
  data?: { restricted?: unknown };
};

const CHECK_INTERVAL_MS = 15_000;

export function AccountRestrictionWatcher() {
  const pathname = usePathname();

  useEffect(() => {
    const protectedPage =
      pathname === "/dashboard" ||
      pathname.startsWith("/dashboard/") ||
      pathname.startsWith("/project/") ||
      pathname === "/adminsh" ||
      pathname.startsWith("/adminsh/") ||
      pathname === RESTRICTED_PATH;
    if (!protectedPage) return;

    let checking = false;

    const checkAccountStatus = async () => {
      if (checking || document.visibilityState === "hidden") return;
      checking = true;

      try {
        const response = await fetch(RESTRICTION_STATUS_API_PATH, {
          cache: "no-store",
          headers: { accept: "application/json" },
        });
        const result = (await response.json()) as RestrictionStatusResponse;

        if (result.code === "ACCOUNT_RESTRICTED" || result.data?.restricted === true) {
          if (pathname !== RESTRICTED_PATH) {
            const target = new URL(RESTRICTED_PATH, window.location.origin);
            if (result.code === "ACCOUNT_RESTRICTED") target.searchParams.set("source", "auth");
            window.location.replace(target.toString());
          }
          return;
        }

        if (result.data?.restricted === false && pathname === RESTRICTED_PATH) {
          window.location.replace("/dashboard");
        }
      } catch {
        console.warn("[account-restriction] status refresh failed");
      } finally {
        checking = false;
      }
    };

    void checkAccountStatus();
    const intervalId = window.setInterval(() => void checkAccountStatus(), CHECK_INTERVAL_MS);
    const onFocus = () => void checkAccountStatus();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void checkAccountStatus();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [pathname]);

  return null;
}
