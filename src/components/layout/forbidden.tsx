import { ShieldAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function Forbidden() {
  return (
    <Card className="mx-auto max-w-md">
      <CardHeader className="items-center text-center">
        <ShieldAlert className="mb-2 h-8 w-8 text-destructive" />
        <CardTitle>Access denied</CardTitle>
        <CardDescription>You do not have permission to view this page.</CardDescription>
      </CardHeader>
      <CardContent className="text-center text-sm text-muted-foreground">
        If you believe this is a mistake, contact your administrator.
      </CardContent>
    </Card>
  );
}
