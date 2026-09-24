import {
  FileUp,
  FolderOpen,
  BookOpen,
  Settings,
  Clock,
  DollarSign,
  Users as UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { useGuestAuth } from "@/contexts/GuestAuthContext";
import { useCurrentUser } from "@/hooks/use-current-user";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export function useNavItems(): NavItem[] {
  const { isGuest } = useGuestAuth();
  const { isAdmin, isMember, isOwner, isOwnerOrAbove, isSuperAdmin } = useCurrentUser();
  const canAct = isMember || isGuest;

  return [
    { href: "/jobs/new", label: "New Job", icon: FileUp },
    { href: "/jobs", label: "Jobs", icon: FolderOpen },
    ...(canAct && !isOwner ? [{ href: "/training", label: "Training", icon: BookOpen }] : []),
    { href: "/activity", label: "Activity", icon: Clock },
    ...(isMember ? [{ href: "/settings/pricing", label: "Pricing", icon: DollarSign }] : []),
    ...(isOwnerOrAbove ? [{ href: "/users", label: "Users", icon: UsersIcon }] : []),
    ...(isSuperAdmin || isAdmin ? [{ href: "/admin", label: "Owner", icon: Settings }] : []),
  ];
}
