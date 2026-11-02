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
    const adminPage =
      pathname === "/adminsh" || (pathname.startsWith("/adminsh/") && pathname !== "/adminsh/auth");
    const protectedPage =
      pathname === "/dashboard" ||
      pathname.startsWith("/dashboard/") ||
      pathname.startsWith("/project/") ||
      adminPage ||
      pathname === RESTRICTED_PATH;
    if (!protectedPage) return;

    let checking = false;

    const checkAccountStatus = async () => {
      if (checking || document.visibilityState === "hidden") return;
      checking = true;

      try {
        const response = await fetch(adminPage ? "/api/admin-auth/status" : RESTRICTION_STATUS_API_PATH, {
          cache: "no-store",
          headers: { accept: "application/json" },
        });
        const result = (await response.json()) as RestrictionStatusResponse;

        if (adminPage) {
          if (
            response.status === 401 ||
            result.code === "ADMIN_SESSION_EXPIRED" ||
            result.code === "ADMIN_AUTHENTICATION_REQUIRED"
          ) {
            const target = new URL("/adminsh/auth", window.location.origin);
            target.searchParams.set("error", "session_expired");
            target.searchParams.set("redirect", "/adminsh/dashboard");
            window.location.replace(target.toString());
            return;
          }
          if (response.status === 403 || result.code === "FORBIDDEN") {
            const target = new URL("/adminsh/auth", window.location.origin);
            target.searchParams.set("error", "unauthorized");
            target.searchParams.set("redirect", "/adminsh/dashboard");
            window.location.replace(target.toString());
          }
          return;
        }

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
