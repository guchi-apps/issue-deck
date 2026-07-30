import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

type UserAvatarProps = {
  login: string;
  className?: string;
};

export function UserAvatar({ login, className }: UserAvatarProps) {
  return (
    <Avatar className={cn("size-6", className)}>
      <AvatarFallback className="text-[10px]">
        {login.slice(0, 2).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}
