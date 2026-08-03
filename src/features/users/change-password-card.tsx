"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** Self-service Change Password (old + new + confirm). Reuses existing auth; invalidates sessions. */
export function ChangePasswordCard() {
  const [oldPassword, setOld] = useState("");
  const [newPassword, setNew] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mut = useMutation({
    mutationFn: () => api.post("/api/users/me/password", { oldPassword, newPassword }),
    onSuccess: () => { setDone(true); setOld(""); setNew(""); setConfirm(""); setError(null); },
    onError: (e) => setError((e as Error).message),
  });

  const submit = () => {
    setError(null); setDone(false);
    if (newPassword.length < 6) return setError("New password must be at least 6 characters");
    if (newPassword !== confirm) return setError("New password and confirmation do not match");
    mut.mutate();
  };

  return (
    <Card className="max-w-md">
      <CardHeader><CardTitle className="text-base">Change Password</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5"><Label>Old Password</Label><Input type="password" value={oldPassword} onChange={(e) => setOld(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>New Password</Label><Input type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} placeholder="At least 6 characters" /></div>
        <div className="space-y-1.5"><Label>Confirm Password</Label><Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {done && <p className="flex items-center gap-1 text-sm text-success"><Check className="h-4 w-4" /> Password changed — other sessions were signed out.</p>}
        <Button onClick={submit} disabled={!oldPassword || !newPassword || !confirm || mut.isPending}>
          {mut.isPending ? "Saving…" : "Change password"}
        </Button>
      </CardContent>
    </Card>
  );
}
