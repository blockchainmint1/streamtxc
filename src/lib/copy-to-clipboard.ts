import { toast } from "sonner";

const COPY_TOAST_ID = "copy-link-toast";

function triggerHaptic() {
  if (typeof navigator === "undefined") return;
  const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
  try {
    nav.vibrate?.(10);
  } catch {
    // ignore
  }
}

async function writeWithFallback(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to legacy path
    }
  }
  if (typeof document === "undefined") return false;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export async function copyToClipboard(
  text: string,
  opts: { successMessage?: string; errorMessage?: string } = {},
): Promise<boolean> {
  const ok = await writeWithFallback(text);
  if (ok) {
    triggerHaptic();
    toast.success(opts.successMessage ?? "✅ Link copied to clipboard", {
      id: COPY_TOAST_ID,
      duration: 2500,
    });
  } else {
    toast.error(opts.errorMessage ?? "⚠️ Unable to copy link", {
      id: COPY_TOAST_ID,
      duration: 2500,
    });
  }
  return ok;
}