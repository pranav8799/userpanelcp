// components/double-confirm-dialog.tsx
import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { AlertTriangle } from "lucide-react";

interface DoubleConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmWord: string;
  actionLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  isLoading?: boolean;
}

export function DoubleConfirmDialog({
  open, title, description, confirmWord, actionLabel, onConfirm, onCancel, isLoading,
}: DoubleConfirmDialogProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    if (open) { setStep(1); setTyped(""); }
  }, [open]);

  if (!open) return null;

  const canConfirm = typed.trim().toUpperCase() === confirmWord.toUpperCase();

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-destructive" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {step === 1 ? (
          <>
            <p className="text-xs px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive">
              This action is irreversible.
            </p>
            <DialogFooter className="gap-2">
              <button onClick={onCancel} className="px-4 py-2 rounded-lg text-sm font-medium border border-border text-muted-foreground">
                Cancel
              </button>
              <button onClick={() => setStep(2)} className="px-4 py-2 rounded-lg text-sm font-bold bg-destructive text-destructive-foreground">
                Continue
              </button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Type <span className="font-bold text-foreground">{confirmWord}</span> to confirm.
              </p>
              <input
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={confirmWord}
                className="w-full rounded-lg px-3 py-2.5 text-sm bg-input border border-border focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <DialogFooter className="gap-2">
              <button onClick={() => setStep(1)} className="px-4 py-2 rounded-lg text-sm font-medium border border-border text-muted-foreground">
                Back
              </button>
              <button
                onClick={onConfirm}
                disabled={!canConfirm || isLoading}
                className="px-4 py-2 rounded-lg text-sm font-bold bg-destructive text-destructive-foreground disabled:opacity-40"
              >
                {isLoading ? "Working…" : actionLabel}
              </button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}