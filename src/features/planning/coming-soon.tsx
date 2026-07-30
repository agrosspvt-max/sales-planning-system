import { Clock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/page-header";

/** Shared placeholder for planning modules whose business logic is a future phase. */
export function ComingSoon({ title, description }: { title: string; description?: string }) {
  return (
    <div className="space-y-6">
      <PageHeader title={title} />
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Clock className="h-6 w-6 text-muted-foreground" />
          </div>
          <p className="text-lg font-medium">Coming Soon</p>
          <p className="max-w-md text-sm text-muted-foreground">
            {description ?? `${title} is not available yet. This module will be enabled in a later phase.`}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
