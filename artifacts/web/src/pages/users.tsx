import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Trash2,
  Pencil,
  ShieldCheck,
  ShieldUser,
  User as UserIcon,
  UserPlus,
  Mail,
  Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useCurrentUser } from "@/hooks/use-current-user";
import {
  listUsers,
  updateUser,
  deleteUser,
  type ManagedUser,
} from "@/lib/users-api";
import {
  listInvitations,
  createInvitation,
  revokeInvitation,
  type Invitation,
  type InviteRole,
} from "@/lib/invitations-api";

type Role = "super_admin" | "owner" | "user";

const ROLE_LABEL: Record<Role, string> = {
  super_admin: "Super Admin",
  owner: "Owner",
  user: "User",
};

const ROLE_ICON: Record<Role, React.ComponentType<{ className?: string }>> = {
  super_admin: ShieldCheck,
  owner: ShieldUser,
  user: UserIcon,
};

const ROLE_BADGE_CLASS: Record<Role, string> = {
  super_admin: "bg-purple-500/10 text-purple-700 dark:text-purple-300 border-purple-500/30",
  owner: "bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30",
  user: "bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/30",
};

function RoleBadge({ role }: { role: Role }) {
  const Icon = ROLE_ICON[role];
  return (
    <Badge variant="outline" className={`gap-1 ${ROLE_BADGE_CLASS[role]}`}>
      <Icon className="h-3 w-3" />
      {ROLE_LABEL[role]}
    </Badge>
  );
}

export default function UsersPage() {
  const qc = useQueryClient();
  const { currentUser, role: callerRole, isSuperAdmin } = useCurrentUser();

  const { data: users, isLoading: usersLoading } = useQuery({
    queryKey: ["users"],
    queryFn: listUsers,
  });

  // Hide the currently logged-in user from the Members list.
  const visibleUsers = (users ?? []).filter((u) => u.id !== currentUser?.id);

  const { data: invitations, isLoading: invitationsLoading } = useQuery({
    queryKey: ["invitations"],
    queryFn: listInvitations,
  });

  const assignableRoles: InviteRole[] =
    callerRole === "super_admin" ? ["super_admin", "owner"] : ["user"];

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InviteRole>(assignableRoles[0]);

  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [deleting, setDeleting] = useState<ManagedUser | null>(null);
  const [revoking, setRevoking] = useState<Invitation | null>(null);

  const inviteMut = useMutation({
    mutationFn: createInvitation,
    onSuccess: () => {
      toast.success(`Invitation sent to ${inviteEmail}.`);
      qc.invalidateQueries({ queryKey: ["invitations"] });
      setInviteEmail("");
    },
    onError: (e: Error) => toast.error(e.message || "Failed to send invitation"),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, ...patch }: { id: string; fullName?: string | null; role?: Role }) =>
      updateUser(id, patch),
    onSuccess: () => {
      toast.success("User updated.");
      qc.invalidateQueries({ queryKey: ["users"] });
      setEditing(null);
    },
    onError: (e: Error) => toast.error(e.message || "Failed to update user"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteUser(id),
    onSuccess: () => {
      toast.success("User deleted.");
      qc.invalidateQueries({ queryKey: ["users"] });
      setDeleting(null);
    },
    onError: (e: Error) => toast.error(e.message || "Failed to delete user"),
  });

  const revokeMut = useMutation({
    mutationFn: (id: string) => revokeInvitation(id),
    onSuccess: () => {
      toast.success("Invitation revoked.");
      qc.invalidateQueries({ queryKey: ["invitations"] });
      setRevoking(null);
    },
    onError: (e: Error) => toast.error(e.message || "Failed to revoke invitation"),
  });

  function handleSendInvite(e: React.FormEvent) {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email || !email.includes("@")) {
      toast.error("Please enter a valid email address.");
      return;
    }
    inviteMut.mutate({ email, role: inviteRole });
  }

  return (
    <div className="container max-w-5xl mx-auto py-8 px-4 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Users &amp; Invitations</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isSuperAdmin
            ? "As super admin you can invite other super admins and owners."
            : "Invite users to your account. They'll receive an email to set their password."}
        </p>
      </div>

      {/* Invite a new member */}
      <section className="rounded-lg border bg-card p-5">
        <div className="flex items-center gap-2 mb-1">
          <UserPlus className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Invite a new member</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          We'll generate a one-time invite link valid for 7 days. Send it to them — they'll set their own password on accept.
        </p>
        <form onSubmit={handleSendInvite} className="grid grid-cols-1 md:grid-cols-[1fr_200px_auto] gap-3 items-end">
          <div>
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="name@company.com"
              data-testid="input-invite-email"
              required
            />
          </div>
          <div>
            <Label htmlFor="invite-role">Role</Label>
            <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as InviteRole)}>
              <SelectTrigger id="invite-role" data-testid="select-invite-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {assignableRoles.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={inviteMut.isPending} data-testid="btn-create-invite">
            {inviteMut.isPending ? "Sending…" : "Create invite"}
          </Button>
        </form>
      </section>

      {/* Pending invitations */}
      <section className="rounded-lg border bg-card p-5">
        <div className="flex items-center gap-2 mb-1">
          <Clock className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Pending invitations</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Members who have been invited but haven't accepted yet.
        </p>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitationsLoading && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!invitationsLoading && (invitations?.length ?? 0) === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                    No pending invitations.
                  </TableCell>
                </TableRow>
              )}
              {invitations?.map((inv) => (
                <TableRow key={inv.id} data-testid={`row-invite-${inv.id}`}>
                  <TableCell className="font-medium">{inv.email}</TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={ROLE_BADGE_CLASS[inv.role]}
                    >
                      {ROLE_LABEL[inv.role]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {new Date(inv.expiresAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRevoking(inv)}
                      data-testid={`btn-revoke-${inv.id}`}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      {/* Members */}
      <section className="rounded-lg border bg-card p-5">
        <div className="flex items-center gap-2 mb-1">
          <Mail className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Members</h2>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          {isSuperAdmin ? "All users across all tenants." : "Users in your account."}
        </p>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usersLoading && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!usersLoading && (visibleUsers.length === 0) && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                    No members yet.
                  </TableCell>
                </TableRow>
              )}
              {visibleUsers.map((u) => {
                const isSelf = currentUser?.id === u.id;
                const canEdit =
                  callerRole === "super_admin" ||
                  (callerRole === "owner" && (u.ownerId === currentUser?.id || isSelf)) ||
                  isSelf;
                const canDelete =
                  !isSelf &&
                  (callerRole === "super_admin" ||
                    (callerRole === "owner" && u.ownerId === currentUser?.id));

                return (
                  <TableRow key={u.id} data-testid={`row-user-${u.id}`}>
                    <TableCell className="font-medium">
                      {u.fullName || <span className="text-muted-foreground italic">No name</span>}
                      {isSelf && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{u.email}</TableCell>
                    <TableCell>
                      <RoleBadge role={u.role} />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!canEdit}
                          onClick={() => setEditing(u)}
                          data-testid={`btn-edit-${u.id}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!canDelete}
                          onClick={() => setDeleting(u)}
                          data-testid={`btn-delete-${u.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </section>

      {editing && (
        <EditUserDialog
          user={editing}
          callerRole={callerRole}
          isSelf={editing.id === currentUser?.id}
          onClose={() => setEditing(null)}
          onSubmit={(patch) => updateMut.mutate({ id: editing.id, ...patch })}
          isPending={updateMut.isPending}
        />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this user?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.email} will be permanently removed and lose access immediately. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleting && deleteMut.mutate(deleting.id)}
              disabled={deleteMut.isPending}
              data-testid="btn-confirm-delete"
            >
              {deleteMut.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!revoking} onOpenChange={(o) => !o && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this invitation?</AlertDialogTitle>
            <AlertDialogDescription>
              The invite link sent to {revoking?.email} will stop working immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => revoking && revokeMut.mutate(revoking.id)}
              disabled={revokeMut.isPending}
              data-testid="btn-confirm-revoke"
            >
              {revokeMut.isPending ? "Revoking…" : "Revoke"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EditUserDialog({
  user,
  callerRole,
  isSelf,
  onClose,
  onSubmit,
  isPending,
}: {
  user: ManagedUser;
  callerRole: Role | "guest";
  isSelf: boolean;
  onClose: () => void;
  onSubmit: (patch: { fullName?: string | null; role?: Role }) => void;
  isPending: boolean;
}) {
  const [fullName, setFullName] = useState(user.fullName ?? "");
  const [role, setRole] = useState<Role>(user.role);

  const canChangeRole = callerRole === "super_admin" && !isSelf;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const patch: { fullName?: string | null; role?: Role } = {
      fullName: fullName.trim() || null,
    };
    if (canChangeRole && role !== user.role) {
      patch.role = role;
    }
    onSubmit(patch);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Edit user</DialogTitle>
            <DialogDescription>{user.email}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label htmlFor="edit-name">Full name</Label>
              <Input
                id="edit-name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                data-testid="input-edit-name"
              />
            </div>
            <div>
              <Label htmlFor="edit-role">Role</Label>
              <Select
                value={role}
                onValueChange={(v) => setRole(v as Role)}
                disabled={!canChangeRole}
              >
                <SelectTrigger id="edit-role" data-testid="select-edit-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="super_admin">Super Admin</SelectItem>
                  <SelectItem value="owner">Owner</SelectItem>
                  <SelectItem value="user">User</SelectItem>
                </SelectContent>
              </Select>
              {!canChangeRole && (
                <p className="text-xs text-muted-foreground mt-1">
                  {isSelf
                    ? "You cannot change your own role."
                    : "Only Super Admins can change roles."}
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending} data-testid="btn-submit-edit">
              {isPending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
