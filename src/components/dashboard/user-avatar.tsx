import { Bot } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { githubAvatarUrl } from "@/lib/github/avatar-url";
import { isBotLogin } from "@/lib/github/is-bot-login";
import { getUserColor } from "@/lib/user-color";
import { cn } from "@/lib/utils";

type UserAvatarProps = {
  login: string;
  image?: string | null;
  className?: string;
};

export function UserAvatar({ login, image, className }: UserAvatarProps) {
  const isBot = isBotLogin(login);
  const avatarSrc = image ?? (isBot ? null : githubAvatarUrl(login));

  return (
    <Avatar className={cn("size-6", className)}>
      {avatarSrc && <AvatarImage src={avatarSrc} alt={login} />}
      <AvatarFallback
        className="text-[10px] text-white"
        style={{ backgroundColor: getUserColor(login) }}
      >
        {isBot ? <Bot className="size-[60%]" /> : login.slice(0, 2).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}
