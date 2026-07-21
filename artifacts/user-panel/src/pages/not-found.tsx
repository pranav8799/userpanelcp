import { AlertCircle } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4">
      <AlertCircle className="w-12 h-12 text-muted-foreground mb-4 opacity-50" />
      <h1 className="text-2xl font-bold tracking-tight mb-2">Page Not Found</h1>
      <p className="text-muted-foreground max-w-sm mb-6">
        The page you are looking for doesn't exist or has been moved.
      </p>
      <Button asChild>
        <Link href="/">Return to Dashboard</Link>
      </Button>
    </div>
  );
}
