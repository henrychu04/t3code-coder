import { createGitLabMergeRequestEnvironmentAtoms } from "@t3tools/client-runtime/state/gitLabMergeRequests";

import { connectionAtomRuntime } from "../connection/runtime";

export const gitLabMergeRequestEnvironment =
  createGitLabMergeRequestEnvironmentAtoms(connectionAtomRuntime);
