import { redirect } from "next/navigation";
import BuilderDashboard from "@/components/builder/BuilderDashboard";
import { loginUrlFor } from "@/lib/auth/redirect";
import { getCurrentUser } from "@/lib/supabase/server";
import { profileFromAuthUser } from "@/lib/user-profile";

/**
 * The builder — the signed-in half of the app.
 *
 * ⚠️ THE CANONICAL ADDRESS IS `/dashboard`. `/home` used to be it and answers
 * a 308 redirect here (`src/lib/legacy-routes.ts`).
 *
 * The page is a server component: it asks Supabase who the visitor is and
 * hands the answer to the client component that does the actual work. Without
 * a session the visitor is sent to `/login`; the proxy does the same thing one
 * layer earlier, this is the second lock on the same door.
 */
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect(loginUrlFor("/dashboard"));
  }

  return <BuilderDashboard profile={profileFromAuthUser(user)} />;
}
