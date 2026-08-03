"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Users2, ArrowLeft } from "lucide-react";
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
import { UsersTablePanel } from "./user-table";

type View = "group" | "all";
interface Group { id: string; name: string; description: string | null; memberCount: number }

/** Users page: Group View (default, cards → group detail) | All Users. Both reuse UsersTablePanel. */
export function UsersManagement() {
  const [view, setView] = useState<View>("group");
  const [group, setGroup] = useState<{ id: string; name: string } | null>(null);

  // Group detail replaces the page content (breadcrumb: Masters > Users > <Group>).
  if (group) return <GroupDetail group={group} onBack={() => setGroup(null)} />;

  return (
    <div className="space-y-5">
      <PageHeader title="Users & Groups" subtitle="Manage Sales Officers, passwords, status and groups." />
      <div className="inline-flex rounded-md border bg-background p-0.5 text-sm">
        {(["group", "all"] as View[]).map((v) => (
          <button key={v} onClick={() => setView(v)} className={cn("rounded px-3 py-1.5 font-medium", view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
            {v === "group" ? "Group View" : "All Users"}
          </button>
        ))}
      </div>
      {view === "group" ? <GroupCards onOpen={setGroup} /> : <UsersTablePanel />}
    </div>
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
        <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> Create Group</Button>
      </div>
      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (groups?.length ?? 0) === 0 ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No groups yet. Create one (MP, UP, WB, CG…).</CardContent></Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {groups!.map((g) => (
            <button key={g.id} onClick={() => onOpen({ id: g.id, name: g.name })} className="text-left">
              <Card className="h-full transition-colors hover:border-primary/50 hover:bg-accent/40">
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="flex items-center gap-2 text-base"><Users2 className="h-4 w-4 text-primary" /> {g.name}</CardTitle>
                  <Badge variant="secondary">{g.memberCount}</Badge>
                </CardHeader>
                <CardContent><p className="text-xs text-muted-foreground">{g.description ?? "Sales Officer group"}</p></CardContent>
              </Card>
            </button>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Create Group</DialogTitle></DialogHeader>
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
        title={`${group.name} Group`}
        subtitle="Sales Officers in this group. Same actions as All Users."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onBack}><ArrowLeft className="h-4 w-4" /> Back</Button>
            <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add Sales Officer</Button>
          </div>
        }
      />
      <UsersTablePanel
        groupId={group.id}
        emptyMessage="No Sales Officers in this group."
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
          <p className="text-xs text-muted-foreground">Only officers not already in another group are shown.</p>
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
