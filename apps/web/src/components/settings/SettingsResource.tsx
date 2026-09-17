import { type FormEvent, type ReactNode } from "react";
import { CoderWorkspaceIssueList } from "../CoderWorkspaceIssues";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { SettingsRow } from "./SettingsPage";
import { Label } from "../ui/label";

/** Resource collections share settings geometry, while keeping their operational controls explicit. */
export function SettingsResource({
  title,
  description,
  status,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <SettingsRow
      title={title}
      description={description}
      status={status}
      control={
        actions ? <div className="flex flex-wrap items-center gap-1.5">{actions}</div> : null
      }
    >
      {children}
    </SettingsRow>
  );
}

export function SettingsResourceEmpty({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="px-3 py-5 text-sm text-muted-foreground sm:px-4">
      {children}
    </p>
  );
}
export interface SettingsResourceFailure {
  title: string;
  details: string;
}
export function SettingsResourceError({
  error,
  retry,
  pending = false,
}: {
  error: SettingsResourceFailure | null;
  retry?: (() => void) | undefined;
  pending?: boolean;
}) {
  if (!error) return null;
  return (
    <div>
      <CoderWorkspaceIssueList
        issues={[
          {
            id: "operation",
            title: error.title,
            summary: "Try again. Technical details are available below.",
            details: error.details,
          },
        ]}
      />
      {retry ? (
        <Button className="mt-2" size="xs" variant="outline" disabled={pending} onClick={retry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
export function SettingsField({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm" htmlFor={id}>
        {label}
      </Label>
      {children}
    </div>
  );
}
export function SettingsResourceDialog({
  title,
  description,
  children,
  pending,
  error,
  onClose,
  onSubmit,
  submitLabel,
  submitDisabled = false,
}: {
  title: string;
  description: string;
  children: ReactNode;
  pending: boolean;
  error: SettingsResourceFailure | null;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
  submitLabel: string;
  submitDisabled?: boolean;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup showCloseButton={!pending}>
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <fieldset disabled={pending} className="space-y-4 px-6 py-4">
            {children}
            <SettingsResourceError error={error} />
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || submitDisabled}>
              {pending ? "Saving…" : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
