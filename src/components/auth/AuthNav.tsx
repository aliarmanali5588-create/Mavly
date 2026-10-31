"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CreditCard, HelpCircle, LogOut, Sparkles, UserRound } from "lucide-react";
import { ConfirmDialog } from "@/components/primitives";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  avatarGradientFor,
  initialsFor,
  type ProfileSummary,
} from "@/lib/user-profile";
import { InstallButton } from "@/components/pwa/InstallButton";

function ProfileAvatar({
  profile,
  className,
}: {
  profile: ProfileSummary;
  className?: string;
}) {
  const initials = initialsFor(profile.name, profile.email);
  const [from, to] = avatarGradientFor(profile.id);

  return (
    <Avatar className={className}>
      {profile.avatarUrl ? (
        <AvatarImage
          src={profile.avatarUrl}
          alt=""
          referrerPolicy="no-referrer"
          className="object-cover"
        />
      ) : null}
      <AvatarFallback
        className="text-[11px] font-semibold text-white"
        style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
      >
        {initials ?? <UserRound className="h-4 w-4" aria-hidden="true" />}
      </AvatarFallback>
    </Avatar>
  );
}

export function AuthNav({ profile }: { profile: ProfileSummary | null }) {
  const [confirmSignOutOpen, setConfirmSignOutOpen] = useState(false);
  const signingOutRef = useRef(false);

  const handleSignOut = async () => {
    if (signingOutRef.current) return;
    signingOutRef.current = true;

    try {
      const response = await fetch("/auth/signout", {
        method: "POST",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`sign out failed (${response.status})`);
      window.location.href = "/";
    } catch {
      signingOutRef.current = false;
      toast.error("We couldn't sign you out. Please try again.");
      throw new Error("sign out failed");
    }
  };

  if (!profile) {
    return (
      <Link
        href="/login"
        className="text-xs text-foreground font-medium px-3.5 py-1.5 rounded-full bg-card border border-[var(--neu-line)] shadow-[var(--neu-elev-1)] hover:shadow-[var(--neu-elev-2)] active:shadow-[var(--neu-inset-1)] active:scale-95 transition-[box-shadow,transform] outline-none focus-visible:shadow-[var(--neu-focus)]"
      >
        Sign in
      </Link>
    );
  }

  const accountLabel = profile.name || profile.email || "Account";
  const displayName = profile.name;
  const email = profile.email;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Open account menu for ${accountLabel}`}
            title={accountLabel}
            className="group flex h-9 w-9 items-center justify-center rounded-full border border-[var(--neu-line)] bg-card p-0.5 shadow-[var(--neu-elev-2)] transition-[box-shadow,border-color] hover:border-[var(--neu-line-strong)] hover:shadow-[var(--neu-elev-3)] active:shadow-[var(--neu-inset-1)] active:scale-95 outline-none focus-visible:shadow-[var(--neu-focus)]"
          >
            <ProfileAvatar
              profile={profile}
              className="h-8 w-8 transition-transform group-hover:scale-[1.03]"
            />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="end"
          sideOffset={8}
          className="w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-[var(--neu-line)] bg-card p-1.5 text-foreground shadow-[var(--neu-float)]"
        >
          <DropdownMenuLabel className="p-0 font-normal">
            <div className="flex items-center gap-3 px-2.5 py-2">
              <ProfileAvatar
                profile={profile}
                className="h-10 w-10 ring-1 ring-black/[0.06]"
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground">
                  {displayName || email || "Signed in"}
                </p>
                {displayName && email ? (
                  <p className="truncate text-xs text-muted-foreground">{email}</p>
                ) : null}
              </div>
            </div>
          </DropdownMenuLabel>

          <DropdownMenuSeparator className="bg-black/[0.06]" />

          <DropdownMenuItem
            asChild
            className="cursor-pointer gap-2.5 rounded-xl px-2.5 py-2 text-[13px] text-foreground focus:bg-[var(--neu-sunken)] focus:text-foreground [&_svg]:text-muted-foreground"
          >
            <Link href="/upgrade">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              <span>Upgrade plan</span>
            </Link>
          </DropdownMenuItem>

          <DropdownMenuItem
            asChild
            className="cursor-pointer gap-2.5 rounded-xl px-2.5 py-2 text-[13px] text-foreground focus:bg-[var(--neu-sunken)] focus:text-foreground [&_svg]:text-muted-foreground"
          >
            <Link href="/credit-topup">
              <CreditCard className="h-4 w-4" aria-hidden="true" />
              <span>Credits / Top up</span>
            </Link>
          </DropdownMenuItem>

          <DropdownMenuItem
            asChild
            className="cursor-pointer gap-2.5 rounded-xl px-2.5 py-2 text-[13px] text-foreground focus:bg-[var(--neu-sunken)] focus:text-foreground [&_svg]:text-muted-foreground"
          >
            <Link href="/support">
              <HelpCircle className="h-4 w-4" aria-hidden="true" />
              <span>Help &amp; Support</span>
            </Link>
          </DropdownMenuItem>

          {/* Install Mavly — renders its own button (and iOS guidance when relevant),
             and renders nothing when already installed or unsupported, so it is safe
             to place directly in the menu content. */}
          <InstallButton />

          <DropdownMenuSeparator className="bg-black/[0.06]" />

          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              setConfirmSignOutOpen(true);
            }}
            className="cursor-pointer gap-2.5 rounded-xl px-2.5 py-2 text-[13px] text-red-600 focus:bg-red-50 focus:text-red-700 [&_svg]:text-red-500"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            <span>Sign out</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={confirmSignOutOpen}
        onOpenChange={setConfirmSignOutOpen}
        title="Sign out of Mavly?"
        description="You'll be signed out of this device and returned to the home page."
        confirmLabel="Sign out"
        cancelLabel="Cancel"
        confirmClassName="bg-primary text-primary-foreground hover:bg-[var(--neu-brand-hover)]"
        onConfirm={handleSignOut}
      />
    </>
  );
}
