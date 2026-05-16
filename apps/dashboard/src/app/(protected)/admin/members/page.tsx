import { Card } from "@/components/ui/card";
import { apiGet } from "@/lib/api-client";

export const dynamic = "force-dynamic";

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: "admin" | "editor" | "guest";
  isActive: boolean;
}

interface Me {
  id: string;
  role: User["role"];
}

export default async function MembersPage() {
  const me = await apiGet<Me>("/users/me");
  if (
    me.status === 401 ||
    me.status === 403 ||
    !me.data ||
    me.data.role !== "admin"
  ) {
    return (
      <Card>
        <h1 className="text-xl font-bold">403 — admin only</h1>
        <p className="text-sm text-neutral-600">
          You need the admin role to manage members.
        </p>
      </Card>
    );
  }
  const list = await apiGet<User[]>("/users");
  const members = list.data ?? [];
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Members</h1>
      <p className="text-sm text-neutral-600">
        Create / edit lands with the simplified-auth UI wave (Phase 3).
      </p>
      <div className="space-y-2">
        {members.map((u) => (
          <Card key={u.id}>
            <p className="font-medium">
              {u.firstName} {u.lastName}
            </p>
            <p className="text-sm text-neutral-600">{u.email}</p>
            <p className="text-xs text-neutral-500">
              {u.role} · {u.isActive ? "active" : "inactive"}
            </p>
          </Card>
        ))}
      </div>
    </div>
  );
}
