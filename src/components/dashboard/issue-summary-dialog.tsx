import { MarkdownBody } from "@/components/dashboard/markdown-body";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Issue } from "@/types/issue";

type IssueSummaryDialogProps = {
  issue: Issue;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function IssueSummaryDialog({ issue, open, onOpenChange }: IssueSummaryDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="break-words">
            #{issue.number} {issue.title}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          <MarkdownBody content={issue.body} repositoryFullName={issue.repositoryFullName} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
