import { reportErrorDiagnostic, setErrorDiagnosticReporter } from "@t3tools/client-runtime/errors";

/** Browser memory and DevTools only: no network requests, storage, or console interception. */
export function installConsoleDiagnostics(): () => void {
  const restoreReporter = setErrorDiagnosticReporter((diagnostic) => {
    console.error(`[t3-error] ${diagnostic.source}`, diagnostic);
  });
  const onError = (event: ErrorEvent) =>
    reportErrorDiagnostic("browser.error", event.error ?? event.message);
  const onRejection = (event: PromiseRejectionEvent) =>
    reportErrorDiagnostic("browser.unhandledrejection", event.reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    restoreReporter();
  };
}
