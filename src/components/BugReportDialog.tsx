import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Bug } from "lucide-react";
import { submitBugReport } from "@/lib/bug-reports.functions";
import { useWallet } from "@/lib/wallet";

const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024; // 2MB

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function BugReportDialog({ trigger }: { trigger?: React.ReactNode }) {
  const { address } = useWallet();
  const submit = useServerFn(submitBugReport);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [telegram, setTelegram] = useState("");
  const [details, setDetails] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const reset = () => {
    setName(""); setEmail(""); setTelegram(""); setDetails(""); setFile(null);
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!details.trim()) {
      toast.error("Please describe the bug");
      return;
    }
    setBusy(true);
    try {
      let attachment_name: string | null = null;
      let attachment_type: string | null = null;
      let attachment_data_url: string | null = null;
      if (file) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          toast.error("Attachment must be under 2MB");
          setBusy(false);
          return;
        }
        attachment_data_url = await fileToDataUrl(file);
        attachment_name = file.name;
        attachment_type = file.type || null;
      }
      await submit({
        data: {
          name: name.trim() || null,
          email: email.trim() || null,
          telegram: telegram.trim() || null,
          details: details.trim(),
          attachment_name,
          attachment_type,
          attachment_data_url,
          page_url: typeof window !== "undefined" ? window.location.href : null,
          user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
          reporter_wallet: address || null,
        },
      });
      toast.success("Bug report sent — thank you!");
      reset();
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <button className="hover:text-foreground transition-colors inline-flex items-center gap-1">
            <Bug className="h-3 w-3" /> bugs
          </button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono">Report a bug</DialogTitle>
          <DialogDescription>
            Found something broken? Tell us what happened. All fields except details are optional.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="bug-name" className="font-mono text-xs">name</Label>
              <Input id="bug-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            </div>
            <div>
              <Label htmlFor="bug-email" className="font-mono text-xs">email</Label>
              <Input id="bug-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={255} />
            </div>
          </div>
          <div>
            <Label htmlFor="bug-telegram" className="font-mono text-xs">telegram</Label>
            <Input id="bug-telegram" value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="@handle" maxLength={120} />
          </div>
          <div>
            <Label htmlFor="bug-details" className="font-mono text-xs">details *</Label>
            <Textarea
              id="bug-details"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              rows={5}
              maxLength={5000}
              placeholder="What happened? What did you expect? Steps to reproduce?"
              required
            />
          </div>
          <div>
            <Label htmlFor="bug-file" className="font-mono text-xs">attachment (optional, max 2MB)</Label>
            <Input
              id="bug-file"
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              accept="image/*,video/*,.pdf,.txt,.log,.json"
            />
            {file && (
              <div className="font-mono text-[10px] text-muted-foreground mt-1">
                {file.name} · {(file.size / 1024).toFixed(0)} KB
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" className="font-mono" onClick={() => setOpen(false)} disabled={busy}>
              cancel
            </Button>
            <Button type="submit" className="font-mono" disabled={busy}>
              {busy ? <><Loader2 className="h-3 w-3 mr-2 animate-spin" /> sending…</> : "send report"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}