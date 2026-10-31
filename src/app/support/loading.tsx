import React from "react";
import { Skeleton } from "@/components/ui/skeleton";

export default function SupportLoading() {
  return (
    <div className="min-h-screen bg-[var(--clay-base)] text-foreground flex flex-col">
      {/* Top Header Placeholder */}
      <header className="sticky top-0 z-50 bg-[color-mix(in_srgb,var(--clay-base)_86%,transparent)] backdrop-blur-md border-b border-[var(--clay-line)]">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Skeleton className="w-8 h-8 rounded-xl bg-black/[0.06]" />
            <Skeleton className="w-20 h-5 rounded-md bg-black/[0.06]" />
          </div>
          <div className="flex items-center gap-3">
            <Skeleton className="w-28 h-8 rounded-full bg-black/[0.06]" />
            <Skeleton className="w-8 h-8 rounded-full bg-black/[0.06]" />
          </div>
        </div>
      </header>

      {/* Main Body Placeholder */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-12 sm:py-16 flex-1 w-full">
        <div className="max-w-2xl mb-12">
          <Skeleton className="w-36 h-6 rounded-full bg-black/[0.06] mb-4" />
          <Skeleton className="w-64 h-10 rounded-lg bg-black/[0.06] mb-3" />
          <Skeleton className="w-full h-4 rounded-md bg-black/[0.06] mb-2" />
          <Skeleton className="w-4/5 h-4 rounded-md bg-black/[0.06]" />
        </div>

        {/* 4 Cards Placeholder */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="bg-card rounded-3xl p-6 sm:p-7 border border-[var(--clay-line)] shadow-xs flex flex-col justify-between h-64"
            >
              <div>
                <div className="flex items-center justify-between mb-4">
                  <Skeleton className="w-11 h-11 rounded-2xl bg-black/[0.06]" />
                  <Skeleton className="w-20 h-5 rounded-full bg-black/[0.06]" />
                </div>
                <Skeleton className="w-48 h-6 rounded-md bg-black/[0.06] mb-3" />
                <Skeleton className="w-full h-4 rounded-md bg-black/[0.06] mb-2" />
                <Skeleton className="w-3/4 h-4 rounded-md bg-black/[0.06]" />
              </div>
              <div className="pt-6 border-t border-[var(--clay-line)] flex items-center justify-between">
                <Skeleton className="w-36 h-5 rounded-md bg-black/[0.06]" />
                <Skeleton className="w-24 h-9 rounded-full bg-black/[0.06]" />
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
