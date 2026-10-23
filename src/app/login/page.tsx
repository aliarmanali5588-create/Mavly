import { redirect } from "next/navigation";
import { DEFAULT_AUTH_DESTINATION, safeInternalPath } from "@/lib/auth/redirect";
import { getCurrentUser } from "@/lib/supabase/server";
import LoginScreen from "./login-screen";

/**
 * The sign-in page.
 *
 * It is a server component so that an already signed-in visitor is sent
 * straight to their destination instead of watching the form flash by.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  const rawRedirect = params.redirect;
  const redirectPath = safeInternalPath(
    Array.isArray(rawRedirect) ? rawRedirect[0] : rawRedirect,
    DEFAULT_AUTH_DESTINATION,
  );

  const rawProvider = params.provider;
  const initialProvider = Array.isArray(rawProvider) ? rawProvider[0] : rawProvider;

  const rawError = params.error;
  const initialError = Array.isArray(rawError) ? rawError[0] : rawError;

  // Already signed in? There is nothing to do here.
  const user = await getCurrentUser();
  if (user) {
    redirect(redirectPath);
  }

  return (
    <LoginScreen
      redirectPath={redirectPath}
      initialProvider={initialProvider ?? null}
      initialError={initialError ?? null}
    />
  );
}
