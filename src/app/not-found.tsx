import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-foreground ">404</h1>
        <h2 className="mt-2 text-3xl font-semibold text-foreground ">
          Page not found
        </h2>
        <p className="mt-4 text-muted-foreground max-w-md mx-auto">
          Sorry, we couldn't find the page you're looking for. Please check the URL or navigate back to the homepage.
        </p>
        <div className="mt-8">
          <Link href="/">
            <Button>
              Go back home
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}