import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { reportVideo } from "@/lib/videos.functions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Flag, Loader2 } from "lucide-react";

const REPORT_REASONS: { value: string; label: string }[] = [
  { value: "nsfw", label: "Adult / pornographic content" },
  { value: "csam", label: "Child sexual abuse material" },
  { value: "violence", label: "Graphic violence or gore" },
  { value: "copyright", label: "Copyright / stolen content" },
  { value: "illegal", label: "Other illegal content" },
  { value: "spam", label: "Spam or misleading" },
  { value: "other", label: "Other (explain below)" },
];

export function ReportButton({ cid }: { cid: string }) {
  const reportFn = useServerFn(reportVideo);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>("");
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!reason) {
      toast.error("Pick a reason");
      return;
    }
    setSubmitting(true);
    try {
      const res = await reportFn({
        data: { cid, reason: reason as never, details },
      });
      if (res.alreadyReported) {
        toast("You've already reported this video today");
      } else {
        toast.success("Report received — video is hidden pending review");
      }
      setOpen(false);
      setReason("");
      setDetails("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to report");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          className="ml-auto flex items-center gap-1.5 text-muted-foreground hover:text-destructive transition-colors"
          aria-label="Report this video"
        >
          <Flag className="h-3.5 w-3.5" />
          report
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono">Report this video</DialogTitle>
          <DialogDescription>
            Reported videos are immediately hidden from the homepage while a
            moderator reviews them. Abuse of this tool may result in IP-level
            blocks.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label className="font-mono text-xs">REASON</Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger>
                <SelectValue placeholder="Pick a reason" />
              </SelectTrigger>
              <SelectContent>
                {REPORT_REASONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label className="font-mono text-xs">DETAILS (optional)</Label>
            <Textarea
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              maxLength={2000}
              rows={3}
              placeholder="Anything a moderator should know"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={submitting || !reason}
          >
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Submitting…
              </>
            ) : (
              <>
                <Flag className="mr-2 h-3 w-3" /> Submit report
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}