import { Bot } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { githubAvatarUrl } from "@/lib/github/avatar-url";
import { COMMENT_AGENT_PROFILES, type CommentAgentRole } from "@/lib/github/comment-source";
import { isBotLogin } from "@/lib/github/is-bot-login";
import { getUserColor } from "@/lib/user-color";
import { cn } from "@/lib/utils";

type UserAvatarProps = {
  login: string;
  image?: string | null;
  /** 役割が解決できたボットコメントに指定する。役割ごとのアイコン・色で表示する */
  agent?: CommentAgentRole | null;
  className?: string;
};

export function UserAvatar({ login, image, agent, className }: UserAvatarProps) {
  const isBot = isBotLogin(login);
  const profile = agent ? COMMENT_AGENT_PROFILES[agent] : null;
  const avatarSrc = image ?? (isBot ? null : githubAvatarUrl(login));
  const Icon = profile?.icon ?? Bot;

  return (
    <Avatar className={cn("size-6", className)}>
      {avatarSrc && <AvatarImage src={avatarSrc} alt={login} />}
      <AvatarFallback
        className="text-[10px] text-white"
        style={{ backgroundColor: profile?.avatarColor ?? getUserColor(login) }}
      >
        {isBot ? <Icon className="size-[60%]" /> : login.slice(0, 2).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}
