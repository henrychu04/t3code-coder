import * as Effect from "effect/Effect";

/**
 * Keep a Git branch rename and its dependent state update consistent.
 * If anything after the rename fails or is interrupted, the rename is
 * compensated before the original cause is propagated.
 */
export function renameBranchWithCompensation<Renamed, RenameError, Result, UpdateError>(input: {
  readonly rename: Effect.Effect<Renamed, RenameError>;
  readonly afterRename: (renamed: Renamed) => Effect.Effect<Result, UpdateError>;
  readonly rollback: (renamed: Renamed) => Effect.Effect<void>;
}): Effect.Effect<Result, RenameError | UpdateError> {
  return Effect.uninterruptibleMask((restore) =>
    restore(input.rename).pipe(
      Effect.flatMap((renamed) =>
        restore(input.afterRename(renamed)).pipe(
          Effect.catchCause((cause) =>
            input.rollback(renamed).pipe(Effect.andThen(Effect.failCause(cause))),
          ),
        ),
      ),
    ),
  );
}
