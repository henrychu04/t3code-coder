// Coder: upstream's `bin.ts` dispatch for `DocumentText.ts`, which runs office document text
// extraction in a child process of the server's own entry point; here that is the helper bundle.
// Both branches import lazily so the extraction child loads only its worker, as upstream's does.
if (process.argv[2] === "__document-text") {
  const { extractDocumentText } = await import("t3/src/provider/documentTextWorker.ts");
  try {
    process.stdout.write(await extractDocumentText(process.argv[3]!, process.argv[4]!));
  } catch (error) {
    if (error instanceof Error && "code" in error && /^E[A-Z0-9]+$/.test(String(error.code))) {
      throw error;
    }
    // Exit 2 identifies document rejections; OS and process failures remain retryable.
    process.exitCode = 2;
  }
} else {
  const [{ coderHelperStdioLayer }, Layer, NodeRuntime] = await Promise.all([
    import("./helper.ts"),
    import("effect/Layer"),
    import("@effect/platform-node/NodeRuntime"),
  ]);
  Layer.launch(coderHelperStdioLayer).pipe(NodeRuntime.runMain);
}
