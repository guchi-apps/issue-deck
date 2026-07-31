import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

type UserAvatarProps = {
  login: string;
  image?: string | null;
  className?: string;
};

export function UserAvatar({ login, image, className }: UserAvatarProps) {
  return (
    <Avatar className={cn("size-6", className)}>
      {image && <AvatarImage src={image} alt={login} />}
      <AvatarFallback className="text-[10px]">
        {login.slice(0, 2).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}
