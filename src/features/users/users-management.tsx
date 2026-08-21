"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Users2, ArrowLeft, BarChart3, PackageCheck } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Role } from "@prisma/client";
import { NativeSelect } from "@/components/ui/select";
import { UsersTablePanel } from "./user-table";

type View = "group" | "all";
interface Group { id: string; name: string; description: string | null; memberCount: number }

/**
 * Users page. Super Admin: Group View (cards → group detail) | All Users. Regional Manager: a scoped,
 * read-only variant — NO Group View, only the Sales Officers of their own group, plus the same
 * Territory Plan button (opening their group's plan). Both reuse UsersTablePanel.
 */
export function UsersManagement({ role = Role.SUPER_ADMIN, groupId = null }: { role?: Role; groupId?: string | null }) {
  const [view, setView] = useState<View>("group");
  const [group, setGroup] = useState<{ id: string; name: string } | null>(null);

  // Regional Manager: no Group View, no user management — just their group's officer list (read-only).
  if (role === Role.REGIONAL_MANAGER) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Users"
          subtitle="Sales Officers in your state."
          actions={
            groupId ? (
              <Button variant="outline" size="sm" asChild>
                <Link href={`/planning/group/${groupId}`}><BarChart3 className="h-4 w-4" /> Territory Plan</Link>
              </Button>
            ) : undefined
          }
        />
        <UsersTablePanel readOnly emptyMessage="No Sales Officers in your state." />
      </div>
    );
  }

  // Group detail replaces the page content (breadcrumb: Masters > Users > <Group>).
  if (group) return <GroupDetail group={group} onBack={() => setGroup(null)} />;

  return (
    <div className="space-y-5">
      <PageHeader title="Users & States" subtitle="Manage Sales Officers, passwords, status and states." />
      <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
        {(["group", "all"] as View[]).map((v) => (
          <button key={v} onClick={() => setView(v)} className={cn("rounded px-3 py-1.5 font-medium", view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
            {v === "group" ? "State View" : "All Users"}
          </button>
        ))}
      </div>
      {view === "group" ? <GroupCards onOpen={setGroup} /> : <AllUsersPanel />}
    </div>
  );
}

/* -------------------------------- All Users ------------------------------- */

/** All Users (Sales Officers + Regional Managers) with a Create User action and role badges/actions. */
function AllUsersPanel() {
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <>
      <UsersTablePanel
        includeManagers
        headerRight={<Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> Create User</Button>}
        emptyMessage="No users yet."
      />
      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}

function CreateUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"SALES_OFFICER" | "REGIONAL_MANAGER">("SALES_OFFICER");
  const [groupId, setGroupId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { data: groups } = useQuery<Group[]>({ queryKey: ["groups"], queryFn: () => api.get<Group[]>("/api/groups"), enabled: open });

  const createMut = useMutation({
    mutationFn: () => api.post("/api/users", { name: name.trim(), username: username.trim(), password, role, groupId: groupId || undefined }),
    onSuccess: () => {
      setName(""); setUsername(""); setPassword(""); setRole("SALES_OFFICER"); setGroupId(""); setError(null);
      onOpenChange(false);
      qc.invalidateQueries({ queryKey: ["officers"] });
      qc.invalidateQueries({ queryKey: ["groups"] });
    },
    onError: (e) => setError((e as Error).message),
  });

  // A Regional Manager must belong to a group (one RM per group).
  const canSubmit = name.trim() && username.trim().length >= 3 && password.length >= 6 && (role === "SALES_OFFICER" || !!groupId) && !createMut.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Create User</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label>Full name *</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>Username *</Label><Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="letters, numbers, . _ -" /></div>
            <div className="space-y-1.5"><Label>Password *</Label><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Role *</Label>
              <NativeSelect value={role} onChange={(e) => setRole(e.target.value as "SALES_OFFICER" | "REGIONAL_MANAGER")}
                options={[{ value: "SALES_OFFICER", label: "Sales Officer" }, { value: "REGIONAL_MANAGER", label: "Regional Manager" }]} />
            </div>
            <div className="space-y-1.5">
              <Label>State {role === "REGIONAL_MANAGER" ? "*" : "(optional)"}</Label>
              <NativeSelect value={groupId} onChange={(e) => setGroupId(e.target.value)}
                options={[{ value: "", label: "No state" }, ...(groups ?? []).map((g) => ({ value: g.id, label: g.name }))]} />
            </div>
          </div>
          {role === "REGIONAL_MANAGER" && <p className="text-xs text-muted-foreground">A state may have only one Regional Manager.</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => createMut.mutate()} disabled={!canSubmit}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------- Group cards ----------------------------- */

function GroupCards({ onOpen }: { onOpen: (g: { id: string; name: string }) => void }) {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const { data: groups, isLoading } = useQuery<Group[]>({ queryKey: ["groups"], queryFn: () => api.get<Group[]>("/api/groups") });

  const createMut = useMutation({
    mutationFn: () => api.post("/api/groups", { name, description: desc || undefined }),
    onSuccess: () => { setCreateOpen(false); setName(""); setDesc(""); qc.invalidateQueries({ queryKey: ["groups"] }); },
  });

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> Create State</Button>
      </div>
      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (groups?.length ?? 0) === 0 ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No states yet. Create one (MP, UP, WB, CG…).</CardContent></Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {groups!.map((g) => (
            <button key={g.id} onClick={() => onOpen({ id: g.id, name: g.name })} className="text-left">
              <Card className="h-full transition-colors hover:border-primary/50 hover:bg-accent/40">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="flex items-center gap-2 text-base"><Users2 className="h-4 w-4 text-primary" /> {g.name}</CardTitle>
                  <Badge variant="secondary">{g.memberCount}</Badge>
                </CardHeader>
                <CardContent><p className="text-xs text-muted-foreground">{g.description ?? "Sales Officer state"}</p></CardContent>
              </Card>
            </button>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Create State</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5"><Label>Name *</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. MP" /></div>
            <div className="space-y-1.5"><Label>Description</Label><Input value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={() => createMut.mutate()} disabled={!name.trim() || createMut.isPending}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------- Group detail ----------------------------- */

function GroupDetail({ group, onBack }: { group: { id: string; name: string }; onBack: () => void }) {
  const [addOpen, setAddOpen] = useState(false);
  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[{ label: "Masters" }, { label: "Users", href: "/masters/users" }, { label: group.name }]}
        title={`${group.name} State`}
        subtitle="Sales Officers in this state. Same actions as All Users."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onBack}><ArrowLeft className="h-4 w-4" /> Back</Button>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/planning/group/${group.id}`}><BarChart3 className="h-4 w-4" /> Territory Plan</Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/groups/${group.id}/catalogue`}><PackageCheck className="h-4 w-4" /> State Catalogue</Link>
            </Button>
            <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add Sales Officer</Button>
          </div>
        }
      />
      <UsersTablePanel
        groupId={group.id}
        includeManagers
        emptyMessage="No users in this state."
        emptyAction={<Button size="sm" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add Sales Officer</Button>}
      />
      <AddOfficersDialog groupId={group.id} open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

function AddOfficersDialog({ groupId, open, onOpenChange }: { groupId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const { data: unassigned } = useQuery<{ id: string; name: string }[]>({
    queryKey: ["unassigned-officers"],
    queryFn: () => api.get("/api/groups/unassigned"),
    enabled: open,
  });
  const addMut = useMutation({
    mutationFn: () => api.post(`/api/groups/${groupId}/members`, { officerIds: selected }),
    onSuccess: () => {
      setSelected([]); onOpenChange(false);
      qc.invalidateQueries({ queryKey: ["officers"] });
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["unassigned-officers"] });
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Add Sales Officer</DialogTitle></DialogHeader>
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Only officers not already in another state are shown.</p>
          <div className="max-h-72 space-y-1 overflow-auto rounded-md border p-2">
            {(unassigned ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No unassigned officers.</p>
            ) : (
              unassigned!.map((o) => (
                <label key={o.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="h-4 w-4" checked={selected.includes(o.id)} onChange={(e) => setSelected((prev) => (e.target.checked ? [...prev, o.id] : prev.filter((x) => x !== o.id)))} />
                  {o.name}
                </label>
              ))
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => addMut.mutate()} disabled={selected.length === 0 || addMut.isPending}>Add {selected.length || ""}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
